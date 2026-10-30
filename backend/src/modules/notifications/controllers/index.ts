import type { Request, Response } from 'express';
import { z } from 'zod';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import * as notificationsService from '../services';

const listQuerySchema = z.object({
	unread: z.enum(['true', 'false']).default('false'),
	limit: z.coerce.number().int().min(1).max(100).default(50),
	cursor: z.string().min(1).max(256).optional(),
}).strict();

function getUserId(req: Request): string {
	if (!req.user) throw new HttpError(401, 'Authentication required.');
	return req.user.id;
}

export async function list(req: Request, res: Response) {
	const query = listQuerySchema.parse(req.query);
	const result = await notificationsService.listMyNotifications(getUserId(req), {
		unreadOnly: query.unread === 'true',
		limit: query.limit,
		cursor: query.cursor,
	});
	res.status(200).json(result);
}

export async function unreadCount(req: Request, res: Response) {
	const count = await notificationsService.getUnreadCount(getUserId(req));
	res.status(200).json({ count });
}

export async function markRead(req: Request, res: Response) {
	const notification = await notificationsService.markMyNotificationRead(getUserId(req), getParam(req, 'id'));
	res.status(200).json(notification);
}

export async function markAllRead(req: Request, res: Response) {
	const result = await notificationsService.markAllMyNotificationsRead(getUserId(req));
	res.status(200).json({ updated: result.count });
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
