import type { Request, Response } from 'express';
import * as authService from '../services';
import { loginSchema, signupSchema } from '../validation';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';

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

/** Coarse request context for the session record — what makes "that other
 * device" recognizable in `GET /auth/sessions`. */
function sessionContext(req: Request): authService.SessionContext {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

function sessionResponse(res: Response, session: authService.AuthSession) {
  setRefreshCookie(res, session.refreshToken);
  res.status(200).json({ user: session.user, accessToken: session.accessToken, sessionId: session.sessionId });
}

export async function signup(req: Request, res: Response) {
  const input = signupSchema.parse(req.body);
  const session = await authService.signup(input, sessionContext(req));
  sessionResponse(res, session);
}

export async function login(req: Request, res: Response) {
  const input = loginSchema.parse(req.body);
  const session = await authService.login(input, sessionContext(req));
  sessionResponse(res, session);
}

export async function refresh(req: Request, res: Response) {
  const token = refreshCookieValue(req);
  if (!token) throw new HttpError(401, 'No refresh token provided.');

  const session = await authService.refresh(token);
  sessionResponse(res, session);
}

export function logout(_req: Request, res: Response) {
  res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTIONS);
  res.status(204).send();
}

// --- Session management (Phase 8 #38) -----------------------------------

function refreshCookieValue(req: Request): string | undefined {
  return (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
}

function requireUserId(req: Request): string {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  return req.user.id;
}

export async function listSessions(req: Request, res: Response) {
  const sessions = await authService.listSessions({
    userId: requireUserId(req),
    currentSessionId: authService.sessionIdFromRefreshToken(refreshCookieValue(req)),
  });
  res.status(200).json(sessions);
}

/** Revokes one of the caller's own sessions. A session id belonging to
 * someone else is simply not found (404) — scoped update, and no signal
 * about whether that id exists. */
export async function revokeSession(req: Request, res: Response) {
  const currentSessionId = authService.sessionIdFromRefreshToken(refreshCookieValue(req));
  const result = await authService.revokeSession({
    userId: requireUserId(req),
    sessionId: getParam(req, 'id'),
    currentSessionId,
  });

  if (!result.revoked) throw new HttpError(404, 'Session not found.');
  // Revoking the session you're using has to clear the cookie in the same
  // response, or the browser keeps sending a dead refresh token.
  if (result.wasCurrent) res.clearCookie(REFRESH_COOKIE, REFRESH_COOKIE_OPTIONS);
  res.status(204).send();
}

/** "Sign out everywhere else" — keeps the caller's current session. */
export async function revokeOtherSessions(req: Request, res: Response) {
  const revoked = await authService.revokeOtherSessions({
    userId: requireUserId(req),
    currentSessionId: authService.sessionIdFromRefreshToken(refreshCookieValue(req)),
  });
  res.status(200).json({ revoked });
}

/** Admin: revoke every session a given user has. Mounted under /admin, not
 * /auth — it acts on someone else's sessions. */
export async function revokeUserSessions(req: Request, res: Response) {
  const revoked = await authService.revokeAllUserSessions(getParam(req, 'id'));
  res.status(200).json({ revoked });
}
