// Auth module's repository — the only place that touches the `User` /
// `PatientProfile` / `DoctorProfile` tables for auth purposes. Other
// modules must go through this module's services, never import this file
// directly (AGENTS.md hard rule 4).
import { prisma } from '../../../db/prisma-client';
import type { Role } from '@prisma/client';

export function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

export function findUserById(id: string) {
  return prisma.user.findUnique({ where: { id } });
}

// --- Refresh sessions (Phase 8 #38) -------------------------------------

export function createRefreshSession(input: { userId: string; userAgent?: string; ip?: string }) {
  return prisma.refreshSession.create({
    data: { userId: input.userId, userAgent: input.userAgent, ip: input.ip },
  });
}

export function findRefreshSessionById(id: string) {
  return prisma.refreshSession.findUnique({ where: { id } });
}

/** The only write a session takes outside of creation/revocation — called
 * from refresh, not from every authenticated request. */
export function touchRefreshSession(id: string) {
  return prisma.refreshSession.update({ where: { id }, data: { lastUsedAt: new Date() } });
}

export function listRefreshSessions(userId: string) {
  return prisma.refreshSession.findMany({
    where: { userId, revokedAt: null },
    orderBy: { lastUsedAt: 'desc' },
  });
}

/** Scoped by `userId` in the WHERE clause rather than checked afterwards —
 * revoking someone else's session is a 0-row update, not a logic branch
 * that could be got wrong. */
export function revokeRefreshSession(id: string, userId: string) {
  return prisma.refreshSession.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export function revokeRefreshSessionsForUser(input: { userId: string; exceptSessionId?: string }) {
  return prisma.refreshSession.updateMany({
    where: {
      userId: input.userId,
      revokedAt: null,
      ...(input.exceptSessionId ? { id: { not: input.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date() },
  });
}

export interface CreateSelfServeUserInput {
  email: string;
  phone?: string;
  passwordHash: string;
  role: Extract<Role, 'patient' | 'doctor'>;
  fullName: string;
}

/** Creates the User row and its matching profile row in one transaction —
 * a User without a profile (or vice versa) should never be observable. */
export function createSelfServeUser(input: CreateSelfServeUserInput) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email,
        phone: input.phone,
        passwordHash: input.passwordHash,
        role: input.role,
      },
    });

    if (input.role === 'patient') {
      await tx.patientProfile.create({
        data: { userId: user.id, fullName: input.fullName },
      });
    } else {
      await tx.doctorProfile.create({
        data: { userId: user.id, fullName: input.fullName },
      });
    }

    return user;
  });
}
