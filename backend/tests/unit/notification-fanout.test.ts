// Issue #330: the Postgres LISTEN/NOTIFY fan-out broker, against a fake
// listener client. The real two-instance path is in
// tests/integration/notification-fanout.test.mts.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NOTIFICATION_FANOUT_CHANNEL,
  PgNotificationBroker,
  decodeFanoutMessage,
  encodeFanoutMessage,
  type ListenerClient,
} from '../../src/modules/notifications/services/fanout';
import { NotificationHub } from '../../src/modules/notifications/services/stream';

const NOTIFICATION_ID = '6f1c2f0e-5a4b-4c3d-9e8f-0a1b2c3d4e5f';
const USER_ID = '0b9a8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d';

class FakeClient extends EventEmitter {
  connected = false;
  queries: string[] = [];
  failConnect = false;
  async connect() {
    if (this.failConnect) throw new Error('connect ECONNREFUSED');
    this.connected = true;
  }
  async query(sql: string) {
    this.queries.push(sql);
  }
  async end() {
    this.connected = false;
  }
  /** Simulate the server terminating the session. */
  kill() {
    this.emit('error', new Error('terminating connection due to administrator command'));
    this.emit('end');
  }
  deliver(payload: string, channel = NOTIFICATION_FANOUT_CHANNEL) {
    this.emit('notification', { processId: 1, channel, payload });
  }
}

function sink() {
  const frames: string[] = [];
  return { frames, write: (frame: string) => void frames.push(frame) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('fan-out payload (no PHI, under the NOTIFY limit)', () => {
  it('serialises exactly notificationId, userId and type — nothing else', () => {
    const payload = encodeFanoutMessage({
      notificationId: NOTIFICATION_ID,
      userId: USER_ID,
      type: 'payment_refunded',
      // An accidental extra field must never reach NOTIFY.
      ...({ payload: { diagnosis: 'secret' } } as object),
    } as never);
    expect(Object.keys(JSON.parse(payload)).sort()).toEqual(['notificationId', 'type', 'userId']);
    expect(payload).not.toContain('secret');
    expect(Buffer.byteLength(payload)).toBeLessThan(8000);
  });

  it('refuses a payload at or over the 8000-byte NOTIFY limit', () => {
    expect(() => encodeFanoutMessage({ notificationId: NOTIFICATION_ID, userId: 'u'.repeat(8000), type: 'x' })).toThrow(
      /NOTIFY size limit/,
    );
  });

  it('decodes only well-formed messages', () => {
    const good = encodeFanoutMessage({ notificationId: NOTIFICATION_ID, userId: USER_ID, type: 'booking_confirmed' });
    expect(decodeFanoutMessage(good)).toEqual({ notificationId: NOTIFICATION_ID, userId: USER_ID, type: 'booking_confirmed' });
    expect(decodeFanoutMessage('not json')).toBeNull();
    expect(decodeFanoutMessage(JSON.stringify({ notificationId: 'nope', userId: USER_ID, type: 't' }))).toBeNull();
    expect(decodeFanoutMessage(JSON.stringify({ notificationId: NOTIFICATION_ID, userId: USER_ID, type: 't', extra: 1 }))).toBeNull();
    expect(decodeFanoutMessage(undefined)).toBeNull();
  });
});

describe('PgNotificationBroker', () => {
  let broker: PgNotificationBroker | undefined;
  afterEach(async () => {
    await broker?.stop();
    vi.useRealTimers();
  });

  function setup() {
    const hub = new NotificationHub();
    const clients: FakeClient[] = [];
    const published: Array<[string, string]> = [];
    broker = new PgNotificationBroker({
      hub,
      createClient: () => {
        const client = new FakeClient();
        clients.push(client);
        return client as unknown as ListenerClient;
      },
      publishSql: async (channel, payload) => void published.push([channel, payload]),
      reconnectMinMs: 100,
      reconnectMaxMs: 400,
    });
    return { hub, clients, published, broker };
  }

  it('LISTENs on the channel and delivers received events to local streams as ids-only frames', async () => {
    const { hub, clients, broker: b } = setup();
    const stream = sink();
    hub.subscribe(USER_ID, stream);
    b.start();
    await flush();
    expect(b.state()).toBe('listening');
    expect(clients[0]!.queries).toEqual([`LISTEN "${NOTIFICATION_FANOUT_CHANNEL}"`]);

    clients[0]!.deliver(encodeFanoutMessage({ notificationId: NOTIFICATION_ID, userId: USER_ID, type: 'payment_refunded' }));
    expect(stream.frames).toEqual([
      `id: ${NOTIFICATION_ID}\nevent: notification\ndata: {"id":"${NOTIFICATION_ID}","type":"payment_refunded"}\n\n`,
    ]);

    clients[0]!.deliver('garbage');
    clients[0]!.deliver(encodeFanoutMessage({ notificationId: NOTIFICATION_ID, userId: USER_ID, type: 'x' }), 'other_channel');
    expect(stream.frames).toHaveLength(1);
  });

  it('publishes through pg_notify and does not deliver locally itself (single path, no duplicates)', async () => {
    const { hub, published, broker: b } = setup();
    const stream = sink();
    hub.subscribe(USER_ID, stream);
    await b.publish({ notificationId: NOTIFICATION_ID, userId: USER_ID, type: 'new_booking' });
    expect(published).toHaveLength(1);
    expect(published[0]![0]).toBe(NOTIFICATION_FANOUT_CHANNEL);
    expect(stream.frames).toHaveLength(0);
  });

  it('reconnects with exponential backoff after losing the connection, then sends resync', async () => {
    vi.useFakeTimers();
    const { hub, clients, broker: b } = setup();
    const stream = sink();
    hub.subscribe(USER_ID, stream);
    b.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.state()).toBe('listening');

    clients[0]!.kill();
    expect(b.state()).toBe('reconnecting');

    // Make the next two attempts fail: 100ms, then 200ms backoff.
    let failNext = 2;
    const originalPush = clients.push.bind(clients);
    clients.push = (...items: FakeClient[]) => {
      for (const item of items) if (failNext-- > 0) item.failConnect = true;
      return originalPush(...items);
    };
    await vi.advanceTimersByTimeAsync(100);
    expect(clients).toHaveLength(2);
    expect(b.state()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(199);
    expect(clients).toHaveLength(2); // still backing off
    await vi.advanceTimersByTimeAsync(1);
    expect(clients).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(400); // capped at reconnectMaxMs
    expect(clients).toHaveLength(4);
    expect(b.state()).toBe('listening');

    // Clients are told to refetch what they may have missed.
    expect(stream.frames.at(-1)).toContain('event: resync');

    // And delivery works on the new connection.
    clients[3]!.deliver(encodeFanoutMessage({ notificationId: NOTIFICATION_ID, userId: USER_ID, type: 'new_booking' }));
    expect(stream.frames.at(-1)).toContain('event: notification');
  });

  it('stop() closes the listener and stops reconnecting', async () => {
    vi.useFakeTimers();
    const { clients, broker: b } = setup();
    b.start();
    await vi.advanceTimersByTimeAsync(0);
    await b.stop();
    expect(b.state()).toBe('stopped');
    expect(clients[0]!.connected).toBe(false);
    clients[0]!.kill();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(clients).toHaveLength(1);
  });
});
