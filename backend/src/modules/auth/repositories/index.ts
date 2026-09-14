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
