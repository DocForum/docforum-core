// Admin bootstrap CLI (Phase 8, issue #39).
//
// Admin accounts are "seeded or invited" per the roadmap, but no supported
// path existed: the preview admin was recreated by hand with an
// `UPDATE "User" SET role = 'admin'` against the Render database (ADR 0003's
// renewal runbook). This is that supported path.
//
// Two rules this script exists to honour:
//   1. Credentials are never read from argv. `ps`, shell history and CI logs
//      all record command lines, so the password is read from stdin instead —
//      silently, when there's a TTY to do it with. A password passed in argv
//      is refused rather than quietly ignored. (The email *is* accepted as a
//      flag: an address is not a secret.)
//   2. Secrets are never printed or logged — no password, no hash, no echo.
//
// Usage:
//   node scripts/create-admin.mjs --email admin@example.com
//   printf 'admin@example.com\n<password>\n' | node scripts/create-admin.mjs
//   node scripts/create-admin.mjs --email admin@example.com --force
//
// `--force` is required when an active admin already exists, so a stray run
// can't quietly add a second administrator.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const SALT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 8;

// Prisma 7 (ADR 0006) requires a driver adapter — `new PrismaClient()` with
// no adapter throws. Same shape as src/db/prisma-client.ts, minus the
// server-only config import (this script runs standalone from the shell).
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
});
const prisma = new PrismaClient({ adapter });

function fail(message) {
  console.error(`create-admin: ${message}`);
  process.exit(1);
}

/** Refuses every argv form of a password rather than "just this once". */
function assertNoPasswordInArgv(argv) {
  const offending = argv.find((arg) => /^--password(=|$)/.test(arg) || /^--password-hash(=|$)/.test(arg));
  if (offending) {
    fail(
      'passwords must not be passed as command-line arguments — they leak via `ps`, shell history and CI logs. ' +
        'Run interactively, or pipe the password on stdin.',
    );
  }
}

function parseArgs(argv) {
  const emailFlag = argv.find((arg) => arg.startsWith('--email='));
  const emailIndex = argv.indexOf('--email');
  return {
    email: emailFlag ? emailFlag.slice('--email='.length) : emailIndex >= 0 ? argv[emailIndex + 1] : undefined,
    force: argv.includes('--force'),
  };
}

/** Prompts for one line, without echoing it when `silent`. Only used when
 * stdin is a TTY — see `readPipedLines` for the other path. */
function promptLine(prompt, { silent = false } = {}) {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.setRawMode?.(silent);

    let value = '';
    const cleanup = () => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stdin.off('error', onError);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') {
          // Ctrl-C — never leave the terminal in raw mode.
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === '\n' || char === '\r') {
          cleanup();
          if (silent) process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    process.stdin.on('data', onData);
    process.stdin.on('error', onError);
  });
}

/** Piped input is read to completion up front — reading line-by-line off a
 * stream loses the rest of a chunk, which silently hangs the second prompt. */
async function readPipedLines() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  // A trailing newline leaves one empty element; that isn't a line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

async function main() {
  const argv = process.argv.slice(2);
  assertNoPasswordInArgv(argv);
  const { email: emailFlag, force } = parseArgs(argv);

  const activeAdmins = await prisma.user.count({ where: { role: 'admin', deactivatedAt: null } });
  if (activeAdmins > 0 && !force) {
    fail(
      `${activeAdmins} active admin account(s) already exist. Re-run with --force to add another, or use ` +
        'POST /admin/invites to invite one.',
    );
  }

  const interactive = Boolean(process.stdin.isTTY);
  const piped = interactive ? [] : await readPipedLines();

  const email = (emailFlag ?? (interactive ? await promptLine('Admin email: ') : piped.shift() ?? '')).trim();
  if (!email) fail('an email address is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`"${email}" does not look like an email address.`);

  if (await prisma.user.findUnique({ where: { email } })) {
    fail(`an account already exists for ${email}. Promote or reactivate it instead of re-creating it.`);
  }

  let password;
  if (interactive) {
    password = await promptLine('Admin password (min 8 chars, not echoed, never in argv): ', { silent: true });
    const confirmation = await promptLine('Confirm password: ', { silent: true });
    if (password !== confirmation) fail('the two passwords did not match.');
  } else {
    // Piped input is `email` then `password` — no confirmation line, so a
    // password can't be typed twice by accident in a script.
    password = piped.shift() ?? '';
  }
  if (password.length < MIN_PASSWORD_LENGTH) fail(`the password must be at least ${MIN_PASSWORD_LENGTH} characters.`);

  // Hashed before anything persistent sees it, and never logged.
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: 'admin',
    },
  });

  console.log(`Created admin ${user.email} (${user.id}).`);
  console.log('The password was not printed, logged or stored anywhere else — put it in your password manager now.');
}

main()
  .catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
  })
  .finally(() => prisma.$disconnect());
