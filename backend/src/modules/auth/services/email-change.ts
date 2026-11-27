import { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma-client';
import { config } from '../../../config';
import { HttpError } from '../../../http-error';
import * as auditService from '../../audit/services';
import type { AuditActor } from '../../audit/services';
import { findUserById, findUserByEmail } from '../repositories';
import { confirmPassword } from './index';
import { generateVerificationToken, hashVerificationToken } from './verification-tokens';
import { sendEmail } from './email-dispatcher';
import { emailThrottleKey } from './login-throttle';

export interface RequestEmailChangeInput {
  newEmail: string;
  password: string;
}

export async function requestEmailChange(
  userId: string,
  input: RequestEmailChangeInput,
  actor: AuditActor,
  ip?: string,
): Promise<{ message: string }> {
  const user = await findUserById(userId);
  if (!user || user.deletedAt) throw new HttpError('AUTHENTICATION_REQUIRED', 'Authentication required.');

  const newEmail = input.newEmail.trim().toLowerCase();
  if (!newEmail) throw new HttpError('INVALID_EMAIL', 'A valid new email address is required.');

  if (user.email.toLowerCase() === newEmail) {
    throw new HttpError('EMAIL_UNCHANGED', 'New email address must be different from current email.');
  }

  // Password confirmation (shares login-throttle brute-force protection)
  await confirmPassword(userId, input.password, ip);

  // Refuse if already registered
  const existing = await findUserByEmail(newEmail);
  if (existing) {
    throw new HttpError('EMAIL_TAKEN', 'An account with this email already exists.');
  }

  const token = generateVerificationToken();
  const tokenHash = hashVerificationToken(token);
  const ttlMs = config.auth.emailVerification.tokenTtlMinutes * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);

  await prisma.$transaction(async (tx) => {
    // Supersede previous unconsumed tokens for this user
    await tx.emailChangeToken.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await tx.emailChangeToken.create({
      data: {
        userId,
        newEmail,
        tokenHash,
        expiresAt,
      },
    });

    await auditService.record(tx, actor, {
      entityType: 'User',
      entityId: user.id,
      action: 'email_change.requested',
      fromState: null,
      toState: null,
      metadata: { domain: newEmail.split('@')[1] ?? null },
    });
  });

  // 1. Send verification link to new email address
  await sendEmail({
    to: newEmail,
    subject: 'Confirm your new DocForum email address',
    text: `Please confirm your email address change by visiting ${config.auth.emailVerification.landingUrl}?token=${encodeURIComponent(token)}`,
  });

  // 2. Send notice to old email address
  await sendEmail({
    to: user.email,
    subject: 'Security Alert: Email address change requested',
    text: `A request was made to change the email address for your DocForum account to ${newEmail}. If you did not request this, please secure your account immediately.`,
  });

  return { message: 'Verification link sent to new email address and notice sent to current address.' };
}

export interface ConfirmEmailChangeInput {
  token: string;
}

export async function confirmEmailChange(
  input: ConfirmEmailChangeInput,
  actor?: AuditActor,
): Promise<{ email: string }> {
  const tokenHash = hashVerificationToken(input.token.trim());
  const record = await prisma.emailChangeToken.findUnique({
    where: { tokenHash },
  });

  if (!record) {
    throw new HttpError('INVALID_TOKEN', 'Invalid email change token.');
  }
  if (record.consumedAt) {
    throw new HttpError('TOKEN_ALREADY_USED', 'This email change token has already been used.');
  }
  if (record.expiresAt.getTime() <= Date.now()) {
    throw new HttpError('TOKEN_EXPIRED', 'This email change token has expired.');
  }

  return prisma.$transaction(async (tx) => {
    // Single-use check: consume token conditionally
    const consumed = await tx.emailChangeToken.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new HttpError('TOKEN_ALREADY_USED', 'This email change token has already been used.');
    }

    // Refuse if new address was taken in the meantime
    const existing = await tx.user.findUnique({
      where: { email: record.newEmail },
    });
    if (existing && existing.id !== record.userId) {
      throw new HttpError('EMAIL_TAKEN', 'An account with this email already exists.');
    }

    const currentUser = await tx.user.findUnique({
      where: { id: record.userId },
      select: { email: true },
    });
    const oldEmail = currentUser?.email;

    try {
      await tx.user.update({
        where: { id: record.userId },
        data: {
          email: record.newEmail,
          emailVerifiedAt: new Date(),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new HttpError('EMAIL_TAKEN', 'An account with this email already exists.');
      }
      throw err;
    }

    // Preserve login-throttle lock from old email to new email if locked
    if (oldEmail) {
      const oldThrottle = await tx.loginAttempt.findUnique({
        where: { scope_key: { scope: 'email', key: emailThrottleKey(oldEmail) } },
      });
      if (oldThrottle && oldThrottle.lockUntil && oldThrottle.lockUntil.getTime() > Date.now()) {
        await tx.loginAttempt.upsert({
          where: { scope_key: { scope: 'email', key: emailThrottleKey(record.newEmail) } },
          create: {
            scope: 'email',
            key: emailThrottleKey(record.newEmail),
            failedCount: oldThrottle.failedCount,
            windowStart: oldThrottle.windowStart,
            lastFailedAt: oldThrottle.lastFailedAt,
            lockUntil: oldThrottle.lockUntil,
          },
          update: {
            failedCount: { increment: oldThrottle.failedCount },
            lockUntil: oldThrottle.lockUntil,
          },
        });
      }
    }

    const auditActorObj: AuditActor = actor ?? {
      userId: record.userId,
      role: null,
      requestId: null,
    };

    await auditService.record(tx, auditActorObj, {
      entityType: 'User',
      entityId: record.userId,
      action: 'email_change.confirmed',
      fromState: null,
      toState: null,
      metadata: { domain: record.newEmail.split('@')[1] ?? null },
    });

    return { email: record.newEmail };
  });
}
