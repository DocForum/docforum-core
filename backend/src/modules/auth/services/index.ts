// Auth services — the only exported surface other modules (and this
// module's own controllers) may call. Never import repositories/* from
// outside this module.
import { HttpError } from '../../../http-error';
import { createSelfServeUser, findUserByEmail, findUserById } from '../repositories';
import { hashPassword, verifyPassword } from './password';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from './tokens';
import type { Role } from '@prisma/client';

// Re-exported so middleware/auth.ts (shared infra, not a peer module) can
// verify tokens through this module's service surface rather than
// reaching into services/tokens.ts directly.
export { verifyAccessToken } from './tokens';
export type { AccessTokenPayload } from './tokens';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthSession {
  user: AuthenticatedUser;
  accessToken: string;
  refreshToken: string;
}

function toPublicUser(user: {
  id: string;
  email: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}): AuthenticatedUser {
  return { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt, updatedAt: user.updatedAt };
}

function issueSession(user: { id: string; role: Role }): { accessToken: string; refreshToken: string } {
  const payload = { sub: user.id, role: user.role };
  return { accessToken: signAccessToken(payload), refreshToken: signRefreshToken(payload) };
}

export interface SignupInput {
  role: Extract<Role, 'patient' | 'doctor'>;
  email: string;
  password: string;
  fullName: string;
}

export async function signup(input: SignupInput): Promise<AuthSession> {
  // Facility accounts are admin-invited only (PRD OQ-2) — enforced here,
  // not just in docforum-web's UI. `Extract<Role, 'patient'|'doctor'>` on
  // the type already narrows this at compile time; this is the runtime
  // guard for a request that bypasses the frontend entirely.
  if (input.role !== 'patient' && input.role !== 'doctor') {
    throw new HttpError(400, 'Self-serve signup is only available for patient or doctor accounts.');
  }

  const existing = await findUserByEmail(input.email);
  if (existing) {
    throw new HttpError(409, 'An account with this email already exists.');
  }

  const passwordHash = await hashPassword(input.password);
  const user = await createSelfServeUser({
    email: input.email,
    passwordHash,
    role: input.role,
    fullName: input.fullName,
  });

  const tokens = issueSession(user);
  return { user: toPublicUser(user), ...tokens };
}

export interface LoginInput {
  email: string;
  password: string;
}

export async function login(input: LoginInput): Promise<AuthSession> {
  const user = await findUserByEmail(input.email);
  // Same message whether the email doesn't exist or the password is wrong
  // — don't leak which one it was.
  if (!user) throw new HttpError(401, 'Invalid email or password.');

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) throw new HttpError(401, 'Invalid email or password.');

  const tokens = issueSession(user);
  return { user: toPublicUser(user), ...tokens };
}

export async function refresh(refreshToken: string): Promise<AuthSession> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new HttpError(401, 'Invalid or expired refresh token.');
  }

  const user = await findUserById(payload.sub);
  if (!user) throw new HttpError(401, 'Invalid or expired refresh token.');

  const tokens = issueSession(user);
  return { user: toPublicUser(user), ...tokens };
}
