// order-tokens controllers
import type { Request, Response } from 'express';
import * as orderTokensService from '../services';
import { verifyOrderTokenSchema, issueOrderTokenSchema } from '../validation';
import { auditActor } from '../../../middleware/request-id';
import { prisma } from '../../../db/prisma-client.js';

function serialize(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_key, field) => typeof field === 'bigint' ? field.toString() : field));
}

export async function verifyOrderToken(req: Request, res: Response) {
  const input = verifyOrderTokenSchema.parse(req.body);
  const actor = auditActor(req);

  // Verify the facility is authenticated
  if (actor.role !== 'facility' || !actor.userId) {
    res.status(403).json({ message: 'Only facilities can verify order tokens' });
    return;
  }

  // Get the facility profile ID from the user ID
  const facility = await prisma.facilityProfile.findUnique({
    where: { userId: actor.userId },
    select: { id: true },
  });

  if (!facility) {
    res.status(403).json({ message: 'Facility profile not found' });
    return;
  }

  const result = await orderTokensService.verifyOrderToken(input.token, facility.id);
  res.json(serialize(result));
}

export async function issueOrderToken(req: Request, res: Response) {
  // This would be called internally when an order is issued
  // For now, we'll expose it as an admin/doctor endpoint for testing
  const input = issueOrderTokenSchema.parse(req.body);
  const actor = auditActor(req);

  if (actor.role !== 'doctor' && actor.role !== 'admin') {
    res.status(403).json({ message: 'Only doctors or admins can issue order tokens' });
    return;
  }

  // Get the order to find the facility
  let facilityId: string;

  if (input.orderType === 'prescription') {
    const prescription = await prisma.prescription.findUnique({
      where: { id: input.orderId },
      select: { facilityProfileId: true },
    });
    if (!prescription) {
      res.status(404).json({ message: 'Prescription not found' });
      return;
    }
    facilityId = prescription.facilityProfileId;
  } else {
    const labOrder = await prisma.labOrder.findUnique({
      where: { id: input.orderId },
      select: { facilityProfileId: true },
    });
    if (!labOrder) {
      res.status(404).json({ message: 'Lab order not found' });
      return;
    }
    facilityId = labOrder.facilityProfileId;
  }

  const tokenData = await orderTokensService.issueOrderToken({
    orderType: input.orderType,
    orderId: input.orderId,
    facilityId,
  });

  res.status(201).json(serialize(tokenData));
}