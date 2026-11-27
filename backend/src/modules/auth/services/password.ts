import bcrypt from 'bcryptjs';
import { HttpError } from '../../../http-error';
import commonPasswords from '../common-passwords.json';

const SALT_ROUNDS = 12;
export const MAX_PASSWORD_BYTES = 72;
export const MIN_PASSWORD_LENGTH = 8;

const COMMON_PASSWORDS_SET = new Set(
  commonPasswords.map((pwd: string) => pwd.toLowerCase()),
);

export function isCommonPassword(plain: string): boolean {
  return COMMON_PASSWORDS_SET.has(plain.toLowerCase());
}

export function validatePasswordStrength(plain: string): void {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`, 'PASSWORD_TOO_SHORT');
  }
  if (Buffer.byteLength(plain, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new HttpError(400, `Password must not exceed ${MAX_PASSWORD_BYTES} bytes.`, 'PASSWORD_TOO_LONG');
  }
  if (isCommonPassword(plain)) {
    throw new HttpError(400, 'This password is too common and easily guessed. Choose a stronger password.', 'PASSWORD_COMMONLY_BREACHED');
  }
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
