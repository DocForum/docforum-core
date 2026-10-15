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

// --- TOTP two-factor auth (Phase 8 #36) ---------------------------------

export function findTwoFactorByUserId(userId: string) {
  return prisma.twoFactorAuth.findUnique({
    where: { userId },
    include: { recoveryCodes: { where: { usedAt: null }, orderBy: { createdAt: 'asc' } } },
  });
}

/** Starts (or restarts) enrollment. Re-enrolling replaces the pending
 * secret; the service refuses this once `enabledAt` is set, so a live
 * second factor can't be silently swapped out by an unauthenticated
 * enrollment call. */
export function upsertTwoFactorEnrollment(input: { userId: string; secretEncrypted: string }) {
  return prisma.twoFactorAuth.upsert({
    where: { userId: input.userId },
    create: { userId: input.userId, secretEncrypted: input.secretEncrypted },
    update: { secretEncrypted: input.secretEncrypted, lastUsedTimeStep: null },
  });
}

/** Confirms enrollment and installs a fresh set of recovery codes in one
 * transaction — there is never a moment where 2FA is enabled with no
 * recovery path. */
export function confirmTwoFactorEnablement(input: {
  twoFactorId: string;
  recoveryCodeHashes: string[];
  enabledAt: Date;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.twoFactorRecoveryCode.deleteMany({ where: { twoFactorAuthId: input.twoFactorId } });
    await tx.twoFactorAuth.update({
      where: { id: input.twoFactorId },
      data: {
        enabledAt: input.enabledAt,
        recoveryCodes: { create: input.recoveryCodeHashes.map((codeHash) => ({ codeHash })) },
      },
    });
  });
}

export function recordTotpTimeStep(twoFactorId: string, timeStep: number) {
  return prisma.twoFactorAuth.update({
    where: { id: twoFactorId },
    data: { lastUsedTimeStep: BigInt(timeStep) },
  });
}

export function markRecoveryCodeUsed(id: string) {
  return prisma.twoFactorRecoveryCode.update({ where: { id }, data: { usedAt: new Date() } });
}

export function deleteTwoFactor(userId: string) {
  return prisma.twoFactorAuth.deleteMany({ where: { userId } });
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
