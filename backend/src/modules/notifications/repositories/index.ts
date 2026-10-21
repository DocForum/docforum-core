// notifications repositories — placeholder. Data access only. Not to be imported
// by other modules directly — go through services/ instead.
import { prisma } from '../../../db/prisma-client';

export function createNotification(data: any) { return prisma.notification.create({ data }); }
export function updateNotification(id: string, data: any) { return prisma.notification.update({ where: { id }, data }); }
export function countSmsForUserSince(userId: string, since: Date) {
  return prisma.notification.count({ where: { userId, channel: 'sms', createdAt: { gte: since }, status: { in: ['queued', 'sent', 'delivered'] } } });
}
export function updateByProviderMessageId(providerMessageId: string, data: any) {
  return prisma.notification.updateMany({ where: { providerMessageId }, data });
}
export function upsertSmsConsent(phone: string, status: 'opted_in' | 'opted_out', source: string) {
  return prisma.smsConsent.upsert({ where: { phone }, create: { phone, status, source }, update: { status, source } });
}
export function findSmsConsent(phone: string) { return prisma.smsConsent.findUnique({ where: { phone } }); }
