// Real-time notification fan-out over Server-Sent Events (Phase 6, issue #97).
//
// This is the in-process part: a hub that holds open streams per user and
// delivers events to them. Persisted replay (Last-Event-ID resume from the
// database) and cross-instance delivery through Postgres LISTEN/NOTIFY are
// not here yet. They need the `Notification.userId` field, which is still a
// schema TODO, and the notification dispatch interface from the same issue.
import { HttpError } from '../../../http-error';

/** Open streams one user may hold at once. Beyond this the stream returns 429. */
export const MAX_STREAMS_PER_USER = 5;

export interface StreamEvent {
  /** Event id sent in the `id:` field. Clients echo it back as `Last-Event-ID`. */
  id?: string;
  /** Named event, e.g. `notification` or `token-expired`. Omitted means the default `message` event. */
  event?: string;
  data: unknown;
}

/**
 * Encode one event as an SSE frame. Multi-line data is split into several
 * `data:` lines, as the SSE format requires.
 */
export function formatSseEvent(event: StreamEvent): string {
  const lines: string[] = [];
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.event !== undefined) lines.push(`event: ${event.event}`);
  for (const line of JSON.stringify(event.data).split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}

export interface StreamSink {
  write(frame: string): void;
}

export class NotificationHub {
  private readonly streams = new Map<string, Set<StreamSink>>();

  /**
   * Register a stream for `userId`. Throws 429 when the user is already at
   * the cap. Returns an `unsubscribe` function that the caller must invoke
   * when the connection closes.
   */
  subscribe(userId: string, sink: StreamSink, maxPerUser = MAX_STREAMS_PER_USER): () => void {
    const existing = this.streams.get(userId) ?? new Set<StreamSink>();
    if (existing.size >= maxPerUser) {
      throw new HttpError(429, 'Too many open notification streams. Close one and try again.', 'STREAM_LIMIT');
    }
    existing.add(sink);
    this.streams.set(userId, existing);
    return () => {
      const current = this.streams.get(userId);
      if (!current) return;
      current.delete(sink);
      if (current.size === 0) this.streams.delete(userId);
    };
  }

  /** Deliver an event to every open stream for `userId`. Returns how many streams received it. */
  publish(userId: string, event: StreamEvent): number {
    const sinks = this.streams.get(userId);
    if (!sinks) return 0;
    const frame = formatSseEvent(event);
    for (const sink of sinks) sink.write(frame);
    return sinks.size;
  }

  /** Open stream count for a user. Used by tests and diagnostics. */
  count(userId: string): number {
    return this.streams.get(userId)?.size ?? 0;
  }
}

export const notificationHub = new NotificationHub();

/** Write a `token-expired` event so the client knows to refresh and reconnect. */
export function tokenExpiredFrame(): string {
  return formatSseEvent({ event: 'token-expired', data: { reason: 'access-token-expired' } });
}
