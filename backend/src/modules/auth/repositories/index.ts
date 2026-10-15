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

// --- Email verification (Phase 8, issue #34) -----------------------------
// Only hashes are stored; see services/verification-tokens.ts.

export function findVerificationTokenByHash(tokenHash: string) {
  return prisma.emailVerificationToken.findUnique({ where: { tokenHash } });
}

export function findLatestVerificationToken(userId: string) {
  return prisma.emailVerificationToken.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

/** Issues the newest token and retires any still-outstanding one, in one
 * transaction — "latest link wins", so a resend doesn't leave two live
 * links in two inboxes. Retiring is a `consumedAt` write, never a delete:
 * this table is an append-only-ish audit of what was issued. */
export function replaceVerificationToken(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.emailVerificationToken.updateMany({
      where: { userId: input.userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return tx.emailVerificationToken.create({
      data: { userId: input.userId, tokenHash: input.tokenHash, expiresAt: input.expiresAt },
    });
  });
}

/** Single-use enforcement, the same shape as the booking guarantee: a
 * conditional UPDATE that only matches while the row is still unused, so
 * two concurrent redemptions of one token can't both win. Returns whether
 * *this* caller consumed it. */
export async function consumeVerificationToken(tokenId: string, consumedAt: Date): Promise<boolean> {
  const result = await prisma.emailVerificationToken.updateMany({
    where: { id: tokenId, consumedAt: null },
    data: { consumedAt },
  });
  return result.count === 1;
}

export function markUserEmailVerified(userId: string, verifiedAt: Date) {
  return prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: verifiedAt } });
}
