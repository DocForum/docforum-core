// Auth module's repository — the only place that touches the `User` /
// `PatientProfile` / `DoctorProfile` / `PasswordResetToken` tables for auth
// purposes. Other modules must go through this module's services, never
// import this file directly (AGENTS.md hard rule 4).
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

/**
 * Stores a new single-use reset token for a user, superseding any of that
 * user's outstanding ones in the same transaction — "requesting a second
 * reset invalidates the first token" is a DB-level guarantee here, not an
 * application-level hope.
 */
export function createPasswordResetToken(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.updateMany({
      where: { userId: input.userId, usedAt: null },
      data: { usedAt: new Date() },
    });
    return tx.passwordResetToken.create({
      data: { userId: input.userId, tokenHash: input.tokenHash, expiresAt: input.expiresAt },
    });
  });
}

/** Lookup by token hash (unique index) — never by the raw token, which is
 * never stored. */
export function findPasswordResetTokenByHash(tokenHash: string) {
  return prisma.passwordResetToken.findUnique({ where: { tokenHash } });
}

/**
 * Consumes a reset token and applies the new password in one transaction:
 * marks the token used, sets the new password hash, and increments
 * `User.tokenVersion` so every previously issued refresh token for this
 * user stops working (issue #33; the full revocation list is #18).
 */
export function consumePasswordResetToken(input: {
  tokenId: string;
  userId: string;
  passwordHash: string;
}) {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: input.tokenId, usedAt: null },
      data: { usedAt: new Date() },
    });
    // Two concurrent confirms of the same token: only one claims the row.
    if (claimed.count !== 1) return false;

    await tx.user.update({
      where: { id: input.userId },
      data: { passwordHash: input.passwordHash, tokenVersion: { increment: 1 } },
    });
    return true;
  });
}
