import type { Request, Response } from 'express';
import * as authService from '../services';
import { loginSchema, signupSchema } from '../validation';
import { HttpError } from '../../../http-error';

const REFRESH_COOKIE = 'docforum_refresh';

// Refresh token travels as an httpOnly cookie — never in a JS-readable
// response field — so a stolen access token (which docforum-web keeps in
// memory, never localStorage) can't be paired with a stolen refresh token
// via the same XSS vector.
//
// KNOWN LIMITATION: `sameSite: 'lax'`/`secure: false` is a local-dev-only
// choice (docforum-web on :5173, this API on :4000 — different origins).
// Cross-site fetch with credentials under SameSite=Lax is not fully
// verified end-to-end in this environment. Production needs `secure: true`
// and a SameSite policy chosen once the real deployment topology (same
// origin via proxy vs. genuinely cross-site) is decided — see
// ARCHITECTURE.md §8 (deployment target: undecided).
function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30d — matches config.jwt.refreshTtl
    path: '/',
  });
}

function sessionResponse(res: Response, session: authService.AuthSession) {
  setRefreshCookie(res, session.refreshToken);
  res.status(200).json({ user: session.user, accessToken: session.accessToken });
}

export async function signup(req: Request, res: Response) {
  const input = signupSchema.parse(req.body);
  const session = await authService.signup(input);
  sessionResponse(res, session);
}

export async function login(req: Request, res: Response) {
  const input = loginSchema.parse(req.body);
  const session = await authService.login(input);
  sessionResponse(res, session);
}

export async function refresh(req: Request, res: Response) {
  const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  if (!token) throw new HttpError(401, 'No refresh token provided.');

  const session = await authService.refresh(token);
  sessionResponse(res, session);
}

export function logout(_req: Request, res: Response) {
  res.clearCookie(REFRESH_COOKIE, { path: '/' });
  res.status(204).send();
}
