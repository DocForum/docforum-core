// Cross-instance real-time notification fan-out (Phase 6, issue #330).
//
// NotificationHub (./stream.ts) only knows the SSE streams open on THIS
// process. With two or more instances, an event published on instance B
// must reach a user whose stream is on instance A. Postgres LISTEN/NOTIFY
// carries it, so no new infrastructure is needed (ARCHITECTURE.md §2):
//
//   notify() ──► broker.publish() ──► pg_notify('docforum_notifications', …)
//                                           │ (every instance, including
//                                           ▼  the publishing one)
//   dedicated LISTEN connection ──► hub.publish(userId, frame) ──► SSE
//
// Delivery is single-path: the publishing instance does NOT deliver
// locally; it receives its own NOTIFY like everyone else, so a user is
// never sent the same event twice.
//
// No PHI ever goes through NOTIFY. The payload is ids only — notification
// id, recipient user id, notification type — well under Postgres's 8000-byte
// NOTIFY limit. Clients fetch the notification itself over HTTP
// (GET /notifications), where owner scoping applies. The SSE frame carries
// the same two fields (`id`, `type`) and nothing else.
//
// Real-time is best-effort by design: the persisted inbox is the record.
// Events NOTIFYed while a listener is disconnected are lost to that
// instance, so after every reconnect each local stream gets a `resync`
// event telling the client to refetch the inbox.
import type { Notification as PgNotification } from 'pg';
import { z } from 'zod';
import { config } from '../../../config';
import { createListenerConnection } from '../../../db/prisma-client';
import { logger } from '../../../logger';
import * as notificationsRepo from '../repositories';
import { notificationHub, type NotificationHub } from './stream';

/** The one channel every instance LISTENs on. A constant identifier — it
 * is never built from input. */
export const NOTIFICATION_FANOUT_CHANNEL = 'docforum_notifications';
/** Postgres rejects a NOTIFY payload of 8000 bytes or more. */
export const NOTIFY_PAYLOAD_MAX_BYTES = 7999;

/** Exactly what crosses NOTIFY. Ids only. */
export interface FanoutMessage {
  notificationId: string;
  userId: string;
  type: string;
}

const fanoutMessageSchema = z
  .object({
    notificationId: z.string().uuid(),
    userId: z.string().min(1).max(64),
    type: z.string().regex(/^[a-z][a-z_]{0,63}$/),
  })
  .strict();

/** Encodes a fan-out message. Builds the object field by field so nothing
 * but the three ids can ever be serialised, then enforces the size limit. */
export function encodeFanoutMessage(message: FanoutMessage): string {
  const payload = JSON.stringify({ notificationId: message.notificationId, userId: message.userId, type: message.type });
  if (Buffer.byteLength(payload, 'utf8') > NOTIFY_PAYLOAD_MAX_BYTES) {
    throw new Error('Notification fan-out payload exceeds the NOTIFY size limit.');
  }
  return payload;
}

/** Parses a received payload; null for anything that isn't a well-formed
 * fan-out message (ignored, never delivered). */
export function decodeFanoutMessage(payload: string | undefined): FanoutMessage | null {
  if (!payload) return null;
  try {
    const parsed = fanoutMessageSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Delivers one message to this instance's open streams for its user. */
export function deliverLocally(hub: NotificationHub, message: FanoutMessage): number {
  return hub.publish(message.userId, {
    id: message.notificationId,
    event: 'notification',
    data: { id: message.notificationId, type: message.type },
  });
}

export type FanoutState = 'local' | 'stopped' | 'connecting' | 'listening' | 'reconnecting';

export interface NotificationBroker {
  publish(message: FanoutMessage): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  state(): FanoutState;
}

/** Single-instance broker: delivers in-process. For NOTIFICATION_FANOUT_DRIVER=local. */
export class LocalNotificationBroker implements NotificationBroker {
  constructor(private readonly hub: NotificationHub) {}

  async publish(message: FanoutMessage): Promise<void> {
    deliverLocally(this.hub, message);
  }

  start(): void {}

  async stop(): Promise<void> {}

  state(): FanoutState {
    return 'local';
  }
}

/** The subset of node-postgres' Client the listener uses (tests can fake it). */
export interface ListenerClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', listener: (message: PgNotification) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  removeAllListeners(): unknown;
}

export interface PgNotificationBrokerOptions {
  hub: NotificationHub;
  createClient: () => ListenerClient;
  publishSql: (channel: string, payload: string) => Promise<void>;
  channel?: string;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

/**
 * Postgres LISTEN/NOTIFY broker. `start()` opens the dedicated listener
 * connection; on any loss (error, server-side termination, failed connect)
 * it reconnects with exponential backoff until `stop()`.
 */
export class PgNotificationBroker implements NotificationBroker {
  private readonly hub: NotificationHub;
  private readonly createClient: () => ListenerClient;
  private readonly publishSql: (channel: string, payload: string) => Promise<void>;
  private readonly channel: string;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;

  private current: ListenerClient | null = null;
  private status: FanoutState = 'stopped';
  private failures = 0;
  private everListened = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(options: PgNotificationBrokerOptions) {
    this.hub = options.hub;
    this.createClient = options.createClient;
    this.publishSql = options.publishSql;
    this.channel = options.channel ?? NOTIFICATION_FANOUT_CHANNEL;
    this.reconnectMinMs = options.reconnectMinMs ?? 500;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(this.channel)) throw new Error('Invalid notification fan-out channel name.');
  }

  async publish(message: FanoutMessage): Promise<void> {
    await this.publishSql(this.channel, encodeFanoutMessage(message));
  }

  state(): FanoutState {
    return this.status;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.status = 'stopped';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const client = this.current;
    this.current = null;
    if (client) {
      client.removeAllListeners();
      client.on('error', () => undefined); // a late socket error must not crash the process
      await client.end().catch(() => undefined);
    }
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    this.status = this.everListened ? 'reconnecting' : 'connecting';
    const client = this.createClient();
    this.current = client;
    client.on('notification', (message) => this.onNotification(message));
    client.on('error', (error) => this.onLost(client, error));
    client.on('end', () => this.onLost(client));
    try {
      await client.connect();
      // The channel passed the identifier check in the constructor.
      await client.query(`LISTEN "${this.channel}"`);
    } catch (error) {
      this.onLost(client, error);
      return;
    }
    if (this.current !== client || !this.running) return; // lost or stopped meanwhile
    const reconnected = this.everListened;
    this.status = 'listening';
    this.everListened = true;
    this.failures = 0;
    if (reconnected) {
      logger.info('[notifications] fan-out listener reconnected');
      // Anything NOTIFYed while we were away is gone: tell clients to refetch.
      this.hub.broadcast({ event: 'resync', data: { reason: 'fanout-reconnected' } });
    }
  }

  private onNotification(message: PgNotification): void {
    if (message.channel !== this.channel) return;
    const decoded = decodeFanoutMessage(message.payload);
    if (!decoded) {
      logger.warn('[notifications] ignored a malformed fan-out message');
      return;
    }
    deliverLocally(this.hub, decoded);
  }

  /** Called at most once per client: tears it down and schedules a retry. */
  private onLost(client: ListenerClient, error?: unknown): void {
    if (this.current !== client) return; // already handled, or superseded
    this.current = null;
    client.removeAllListeners();
    client.on('error', () => undefined);
    void client.end().catch(() => undefined);
    if (!this.running) return;
    this.status = this.everListened ? 'reconnecting' : 'connecting';
    const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** this.failures);
    this.failures += 1;
    // Never log the error's connection details; the message is enough.
    logger.warn(
      { retryInMs: delay, reason: error instanceof Error ? error.message : 'connection ended' },
      '[notifications] fan-out listener lost its connection',
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

export function createNotificationBroker(hub: NotificationHub = notificationHub): NotificationBroker {
  if (config.notificationFanout.driver === 'local') return new LocalNotificationBroker(hub);
  return new PgNotificationBroker({
    hub,
    createClient: createListenerConnection,
    publishSql: notificationsRepo.pgNotify,
    reconnectMinMs: config.notificationFanout.reconnectMinMs,
    reconnectMaxMs: config.notificationFanout.reconnectMaxMs,
  });
}

/** The process-wide broker. Publishing works as soon as the module loads;
 * the LISTEN side starts only from src/server.ts (`startNotificationFanout`),
 * so test suites that just build the app open no extra connection. */
export const notificationBroker: NotificationBroker = createNotificationBroker();

export function startNotificationFanout(): () => Promise<void> {
  notificationBroker.start();
  return () => notificationBroker.stop();
}

export function getNotificationFanoutState(): FanoutState {
  return notificationBroker.state();
}
