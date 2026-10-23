// notifications controllers — the SSE stream endpoint (issue #97).
import type { Request, Response } from 'express';
import { HttpError } from '../../../http-error';
import { verifyAccessToken } from '../../auth/services';
import { notificationHub, tokenExpiredFrame } from '../services/stream';

/** Heartbeat comment interval. Keeps proxies from closing an idle stream. */
const HEARTBEAT_MS = 15_000;
/** Client retry hint sent once on connect, in milliseconds. */
const RETRY_MS = 5_000;

export function stream(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const userId = req.user.id;

  // The access token expires mid-stream. Read its `exp` to schedule the close.
  const token = req.headers.authorization?.slice('Bearer '.length) ?? '';
  const exp = (verifyAccessToken(token) as { exp?: number }).exp;

  // Registering first means a 429 is returned before any stream headers go out.
  const unsubscribe = notificationHub.subscribe(userId, {
    write: (frame: string) => res.write(frame),
  });

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Stops nginx-style proxies from buffering the stream. Render's proxy honours it too.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`retry: ${RETRY_MS}\n\n`);

  // `Last-Event-ID` is accepted but not replayed yet; see services/stream.ts.
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);
  const expiry =
    exp === undefined
      ? undefined
      : setTimeout(() => {
          res.write(tokenExpiredFrame());
          res.end();
        }, Math.max(0, exp * 1000 - Date.now()));

  req.on('close', () => {
    clearInterval(heartbeat);
    if (expiry) clearTimeout(expiry);
    unsubscribe();
  });
}
