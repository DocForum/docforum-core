import type { Request, Response } from 'express';
import * as service from '../services';

export async function webhook(req: Request, res: Response) {
  const rawBody = JSON.stringify(req.body);
  const result = await service.recordDelivery(req.params.channel as 'email' | 'sms', rawBody, req.header('x-notification-signature'));
  res.status(200).json(result);
}
