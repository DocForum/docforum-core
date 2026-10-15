// Interim admin/dev tool (Phase 8, issue #34).
//
// No email provider is integrated yet — choosing one is Phase 6, tracked as
// issue #17 — which means an account created through `POST /auth/signup`
// cannot complete verification on the hosted preview until a provider
// exists. This script is the documented out-of-band path for an operator
// with database access: it marks an existing account's email as verified so
// the preview stays usable.
//
// It is NOT a bypass of the guard and NOT a user-facing feature: it needs
// database credentials, i.e. the same access a plain SQL UPDATE would need.
// Delete this script once issue #17 lands.
//
// Usage:
//   node scripts/mark-email-verified.mjs <email>
//   node scripts/mark-email-verified.mjs            # prompts for the email
//
// The email is not a secret, so taking it from argv is fine (compare the
// admin bootstrap CLI in issue #39, where the password must never be).
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function resolveEmail() {
  const fromArgv = process.argv[2];
  if (fromArgv) return fromArgv.trim();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Email address to mark verified: ');
  rl.close();
  return answer.trim();
}

async function main() {
  const email = await resolveEmail();
  if (!email) throw new Error('An email address is required.');

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error(`No account found for ${email}.`);
  if (user.emailVerifiedAt) {
    console.log(`${email} is already verified (${user.emailVerifiedAt.toISOString()}).`);
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  console.log(`Marked ${email} as verified.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
