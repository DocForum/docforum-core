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
}
