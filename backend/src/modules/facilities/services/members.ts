import { HttpError } from '../../../http-error';
import { prisma as db } from '../../../db/prisma-client';
import type { FacilityRole } from '@prisma/client';

export interface FacilityMember {
  id: string;
  userId: string;
  facilityId: string;
  role: FacilityRole;
  createdAt: Date;
  email?: string;
}

export class FacilityService {
  /** List all members of a facility. */
  async getMembers(facilityId: string) {
    return db.facilityMember.findMany({
      where: { facilityId },
      include: { user: { select: { id: true, email: true, role: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Get the member record for a user in a facility. */
  async getMember(facilityId: string, userId: string): Promise<FacilityMember | null> {
    return db.facilityMember.findFirst({
      where: { facilityId, userId },
    });
  }

  /** Check if the authenticated user is an owner of the given facility. */
  async isOwner(facilityId: string, userId: string): Promise<boolean> {
    const member = await db.facilityMember.findFirst({
      where: { facilityId, userId, role: 'owner' },
    });
    return !!member;
  }

  /** Check if the authenticated user is a member (owner or staff) of the given facility. */
  async isMember(facilityId: string, userId: string): Promise<boolean> {
    const member = await db.facilityMember.findFirst({
      where: { facilityId, userId },
    });
    return !!member;
  }

  /** Create a new facility member with the given role. */
  async createMember(facilityId: string, userId: string, role: FacilityRole): Promise<FacilityMember> {
    // Ensure the user is not already in a facility (unique constraint on userId)
    const existing = await db.facilityMember.findUnique({ where: { userId } });
    if (existing) {
      throw new HttpError(400, 'User already belongs to a facility.');
    }
    return db.facilityMember.create({
      data: { userId, facilityId, role },
    });
  }

  /** Remove a staff member from a facility. */
  async removeMember(facilityId: string, userId: string, removerUserId: string): Promise<void> {
    // Check remover is an owner
    const remover = await db.facilityMember.findFirst({
      where: { facilityId, userId: removerUserId, role: 'owner' },
    });
    if (!remover) {
      throw new HttpError(403, 'Only facility owners can remove members.');
    }

    // Check we're not removing the last owner
    const ownerCount = await db.facilityMember.count({
      where: { facilityId, role: 'owner' },
    });
    if (ownerCount <= 1 && (await this.isOwner(facilityId, removerUserId))) {
      throw new HttpError(400, 'Cannot remove the last owner of a facility.');
    }

    // userId is globally unique (@@unique([userId])), so delete by userId only
    await db.facilityMember.delete({ where: { userId } });
  }
}