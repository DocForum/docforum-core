import type { Request, Response } from 'express';
import { metricsQuerySchema } from '../validation';
import * as metricsService from '../services';

export async function getMetrics(req: Request, res: Response) {
  const query = metricsQuerySchema.parse(req.query);
  res.status(200).json(await metricsService.getSuccessMetrics(query.from, query.to));
}
