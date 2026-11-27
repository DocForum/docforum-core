// Issue #335: per-request deadline middleware and HTTP timeout config.
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { isDeadlineExempt, requestDeadline } from '../../src/middleware/deadline';
import { config } from '../../src/config';

function fakeRes() {
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      res.headersSent = true;
      res.emit('finish');
      return res;
    },
  });
  return res;
}

function run(path: string, timeoutMs = 1_000) {
  const res = fakeRes();
  const next = vi.fn();
  requestDeadline(timeoutMs)({ path } as Request, res as unknown as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return res;
}

describe('requestDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers 503 REQUEST_TIMEOUT when a request outlives its deadline', () => {
    const res = run('/appointments/mine');
    vi.advanceTimersByTime(999);
    expect(res.headersSent).toBe(false);
    vi.advanceTimersByTime(1);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ message: 'The request took too long to complete.', code: 'REQUEST_TIMEOUT' });
  });

  it('leaves a request that finished in time alone', () => {
    const res = run('/appointments/mine');
    res.status(200).json({ ok: true });
    vi.advanceTimersByTime(5_000);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('does nothing when the client went away first', () => {
    const res = run('/appointments/mine');
    res.emit('close');
    vi.advanceTimersByTime(5_000);
    expect(res.body).toBeUndefined();
  });

  it('does not overwrite a response that already started', () => {
    const res = run('/appointments/mine');
    res.headersSent = true;
    vi.advanceTimersByTime(5_000);
    expect(res.statusCode).toBe(200);
  });

  it('never times out the SSE stream or file transfers', () => {
    for (const path of [
      '/notifications/stream',
      '/lab-results/abc/download',
      '/orders/lab-orders/abc/result',
      '/consultations/messages/attachments/abc/file',
      '/patients/me/export/abc/download',
    ]) {
      expect(isDeadlineExempt(path)).toBe(true);
      const res = run(path);
      vi.advanceTimersByTime(60_000);
      expect(res.body).toBeUndefined();
    }
  });

  it('applies to ordinary API routes', () => {
    for (const path of ['/appointments/doctor/cancel-day', '/notifications', '/lab-orders', '/patients/me/export']) {
      expect(isDeadlineExempt(path)).toBe(false);
    }
  });
});

describe('config.http (issue #335)', () => {
  it('keeps keep-alive above a 5-minute proxy idle timeout and headers within the request timeout', () => {
    expect(config.http.keepAliveTimeout).toBeGreaterThan(300_000);
    expect(config.http.headersTimeout).toBeLessThanOrEqual(config.http.requestTimeout);
    expect(config.http.requestDeadline).toBeGreaterThan(0);
  });
});
