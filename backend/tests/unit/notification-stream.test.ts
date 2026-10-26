import { describe, expect, it } from 'vitest';
import {
  MAX_STREAMS_PER_USER,
  NotificationHub,
  formatSseEvent,
  tokenExpiredFrame,
} from '../../src/modules/notifications/services/stream';

function sink() {
  const frames: string[] = [];
  return { frames, write: (frame: string) => void frames.push(frame) };
}

describe('formatSseEvent', () => {
  it('writes id, event and a data line', () => {
    expect(formatSseEvent({ id: '7', event: 'notification', data: { type: 'referral' } })).toBe(
      'id: 7\nevent: notification\ndata: {"type":"referral"}\n\n',
    );
  });

  it('omits id and event when they are not set', () => {
    expect(formatSseEvent({ data: 'hi' })).toBe('data: "hi"\n\n');
  });

  it('splits multi-line JSON across data lines', () => {
    const frame = formatSseEvent({ data: 'a\nb' });
    expect(frame).toBe('data: "a\\nb"\n\n');
    expect(formatSseEvent({ data: { text: 'x' } }).split('\n').filter((line) => line.startsWith('data:'))).toHaveLength(1);
  });

  it('builds the token-expired frame the client waits for', () => {
    expect(tokenExpiredFrame()).toBe('event: token-expired\ndata: {"reason":"access-token-expired"}\n\n');
  });
});

describe('NotificationHub', () => {
  it('delivers to every open stream for the user only', () => {
    const hub = new NotificationHub();
    const mine = sink();
    const mineAgain = sink();
    const other = sink();
    hub.subscribe('user-a', mine);
    hub.subscribe('user-a', mineAgain);
    hub.subscribe('user-b', other);

    expect(hub.publish('user-a', { id: '1', data: 'x' })).toBe(2);
    expect(mine.frames).toEqual(['id: 1\ndata: "x"\n\n']);
    expect(mineAgain.frames).toHaveLength(1);
    expect(other.frames).toHaveLength(0);
  });

  it('returns 0 when the user has no open stream', () => {
    expect(new NotificationHub().publish('nobody', { data: 'x' })).toBe(0);
  });

  it('stops delivering after unsubscribe', () => {
    const hub = new NotificationHub();
    const s = sink();
    const unsubscribe = hub.subscribe('user-a', s);
    unsubscribe();
    hub.publish('user-a', { data: 'x' });
    expect(s.frames).toHaveLength(0);
    expect(hub.count('user-a')).toBe(0);
  });

  it('caps open streams per user and returns 429 beyond the cap', () => {
    const hub = new NotificationHub();
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) hub.subscribe('user-a', sink());
    expect(() => hub.subscribe('user-a', sink())).toThrow(expect.objectContaining({ status: 429 }));
    expect(hub.count('user-a')).toBe(MAX_STREAMS_PER_USER);
  });

  it('frees a slot when a stream closes, so a new one can connect', () => {
    const hub = new NotificationHub();
    const unsubscribes = Array.from({ length: MAX_STREAMS_PER_USER }, () => hub.subscribe('user-a', sink()));
    unsubscribes[0]();
    expect(() => hub.subscribe('user-a', sink())).not.toThrow();
  });
});
