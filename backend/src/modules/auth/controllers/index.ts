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
// docforum-web (GitHub Pages) and this API (Render, see docs/adr/0003-
// render-preview-deployment.md) are genuinely cross-site — different
// domains entirely, not just different ports. A cross-site cookie only
// gets sent on a `fetch` with `credentials: 'include'` if it's
// `SameSite=None; Secure`. `Secure` requires HTTPS, which local dev
// (http://localhost) doesn't have — hence the NODE_ENV branch: real
// cross-site behavior in production, a cookie that still works over plain
// http in local dev.
const isProduction = process.env.NODE_ENV === 'production';
const REFRESH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? ('none' as const) : ('lax' as const),
  path: '/',
};

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    ...REFRESH_COOKIE_OPTIONS,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30d — matches config.jwt.refreshTtl
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
  res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTIONS);
  res.status(204).send();
}
