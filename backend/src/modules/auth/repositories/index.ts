// Auth module's repository — the only place that touches the `User` /
// `PatientProfile` / `DoctorProfile` / `PasswordResetToken` tables for auth
// purposes. Other modules must go through this module's services, never
// import this file directly (AGENTS.md hard rule 4).
import { prisma } from '../../../db/prisma-client';
import type { Prisma, Role } from '@prisma/client';

export function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
}

export function findUserById(id: string, db: typeof prisma | Prisma.TransactionClient = prisma) {
  return db.user.findUnique({ where: { id } });
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
  locale?: string;
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
        locale: input.locale ?? 'en',
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

// --- Login throttling (Phase 8, issue #35) -------------------------------

export interface ThrottleRow {
  scope: string;
  key: string;
  failedCount: number;
  lastFailedAt: Date;
  lockUntil: Date | null;
}

/**
 * Records one failed attempt for a bucket, atomically.
 *
 * This is a single INSERT ... ON CONFLICT DO UPDATE, not a read followed by
 * a write: concurrent failed logins for the same account must all be
 * counted, and a read-then-write would silently drop all but the last one.
 * The three CASE expressions all read the *pre-update* row, which is what
 * makes the window reset, the increment and the lock decision consistent
 * with each other inside one statement.
 *
 * `gen_random_uuid()` is built in from Postgres 13 (no extension needed);
 * Prisma normally generates the uuid client-side, which raw SQL can't.
 *
 * The lock is set once per window (`lockUntil IS NULL` guard): a client that
 * keeps hammering a locked account grows the counter but does *not* push the
 * lock's deadline out, so the lock is a bounded wait rather than a way to
 * keep a legitimate user locked out indefinitely. The next window (which
 * clears both the count and the lock) can lock again.
 */
export async function recordFailedLoginAttempt(input: {
  scope: 'email' | 'ip';
  key: string;
  policy: { windowSeconds: number; lockAfterFailures: number; lockSeconds: number };
}): Promise<ThrottleRow> {
  const { windowSeconds, lockAfterFailures, lockSeconds } = input.policy;
  const expiredWindow = prisma.$queryRaw<ThrottleRow[]>`
    INSERT INTO "LoginAttempt" ("id", "scope", "key", "failedCount", "windowStart", "lastFailedAt", "lockUntil", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${input.scope}, ${input.key}, 1, NOW(), NOW(), NULL, NOW(), NOW())
    ON CONFLICT ("scope", "key") DO UPDATE SET
      "failedCount" = CASE
        WHEN "LoginAttempt"."windowStart" < NOW() - make_interval(secs => ${windowSeconds}::int) THEN 1
        ELSE "LoginAttempt"."failedCount" + 1
      END,
      "windowStart" = CASE
        WHEN "LoginAttempt"."windowStart" < NOW() - make_interval(secs => ${windowSeconds}::int) THEN NOW()
        ELSE "LoginAttempt"."windowStart"
      END,
      "lockUntil" = CASE
        WHEN "LoginAttempt"."windowStart" < NOW() - make_interval(secs => ${windowSeconds}::int) THEN NULL
        WHEN (CASE
          WHEN "LoginAttempt"."windowStart" < NOW() - make_interval(secs => ${windowSeconds}::int) THEN 1
          ELSE "LoginAttempt"."failedCount" + 1
        END) >= ${lockAfterFailures}::int
          AND "LoginAttempt"."lockUntil" IS NULL
          THEN NOW() + make_interval(secs => ${lockSeconds}::int)
        ELSE "LoginAttempt"."lockUntil"
      END,
      "lastFailedAt" = NOW(),
      "updatedAt" = NOW()
    RETURNING "scope", "key", "failedCount", "lastFailedAt", "lockUntil"
  `;
  const rows = await expiredWindow;
  if (!rows[0]) throw new Error('LoginAttempt upsert returned no row.');
  return rows[0];
}

export function findThrottleBuckets(emailKey: string, ipKey: string | null): Promise<ThrottleRow[]> {
  const clauses: { scope: string; key: string }[] = [{ scope: 'email', key: emailKey }];
  if (ipKey) clauses.push({ scope: 'ip', key: ipKey });
  return prisma.loginAttempt.findMany({
    where: { OR: clauses },
    select: { scope: true, key: true, failedCount: true, lastFailedAt: true, lockUntil: true },
  });
}

export function clearLoginAttempts(buckets: { scope: string; key: string }[]) {
  if (buckets.length === 0) return Promise.resolve(0);
  return prisma.loginAttempt
    .deleteMany({ where: { OR: buckets.map((bucket) => ({ scope: bucket.scope, key: bucket.key })) } })
    .then((result) => result.count);
}

/** Cleanup: drop buckets whose last failure is older than `before`. */
export function pruneStaleLoginAttempts(before: Date) {
  return prisma.loginAttempt.deleteMany({ where: { lastFailedAt: { lt: before } } }).then((result) => result.count);
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

// --- Account deletion (Phase 8, issue #41, docs/adr/0010) ----------------
// Called inside the patients module's deletion transaction, so every write
// here takes the caller's transaction client.

type DbClient = typeof prisma | Prisma.TransactionClient;

/** Anonymises the User row in place. Conditional on `deletedAt IS NULL`, so
 * of two concurrent deletions exactly one does the work; returns whether
 * this call did. */
export async function anonymizeUser(
  db: DbClient,
  userId: string,
  data: { tombstoneEmail: string; unusablePasswordHash: string; deletedAt: Date },
): Promise<boolean> {
  const result = await db.user.updateMany({
    where: { id: userId, deletedAt: null },
    data: {
      email: data.tombstoneEmail,
      phone: null,
      passwordHash: data.unusablePasswordHash,
      emailVerifiedAt: null,
      deletedAt: data.deletedAt,
    },
  });
  return result.count === 1;
}

export function deleteVerificationTokensForUser(db: DbClient, userId: string) {
  return db.emailVerificationToken.deleteMany({ where: { userId } }).then((result) => result.count);
}

export function deleteLoginAttemptBucket(db: DbClient, scope: 'email' | 'ip', key: string) {
  return db.loginAttempt.deleteMany({ where: { scope, key } }).then((result) => result.count);
}

/** Hard-deletes an already-anonymised User (tombstone purge). Conditional
 * on `deletedAt` being set, so a live account can never be removed here. */
export async function deleteAnonymizedUser(db: DbClient, userId: string): Promise<boolean> {
  const result = await db.user.deleteMany({ where: { id: userId, deletedAt: { not: null } } });
  return result.count === 1;
}
