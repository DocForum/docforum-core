import type { Request, Response } from 'express';
import * as authService from '../services';
import {
  clearLoginAttemptsSchema,
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  signupSchema,
  signupWithInviteSchema,
  verifyEmailSchema,
} from '../validation';
import { HttpError } from '../../../http-error';
import { config } from '../../../config';
import { readCsrfHeader } from '../../../middleware/csrf';
import { getParam } from '../../../request-params';
import { resolveLocale } from '../../../i18n';

const REFRESH_COOKIE = 'docforum_refresh';
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30d — matches config.jwt.refreshTtl

// Refresh token travels as an httpOnly cookie — never in a JS-readable
// response field — so a stolen access token (which docforum-web keeps in
// memory, never localStorage) can't be paired with a stolen refresh token
// via the same XSS vector.
//
// Cookie attributes come from config.cookie (Phase 8, issue #37): genuinely
// environment-aware — `SameSite=None; Secure` in production, where
// docforum-web (GitHub Pages) and this API (Render) are different sites, and
// `SameSite=Lax`/insecure for local dev over plain http. See
// docs/adr/0003.
function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    ...config.cookie,
    httpOnly: true,
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
  });
}

/** Coarse request context for the session record — what makes "that other
 * device" recognizable in `GET /auth/sessions`. */
function sessionContext(req: Request): authService.SessionContext {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

function sessionResponse(res: Response, session: authService.AuthSession) {
  setRefreshCookie(res, session.refreshToken);
  // `csrfToken` is returned in the body, not as a readable cookie — see
  // middleware/csrf.ts for why a cross-site frontend can't use a cookie for
  // this. docforum-web keeps it in memory alongside the access token.
  res.status(200).json({
    user: session.user,
    accessToken: session.accessToken,
    csrfToken: session.csrfToken,
    sessionId: session.sessionId,
  });
}

export async function signup(req: Request, res: Response) {
  const input = signupSchema.parse(req.body);
  const session = await authService.signup(
    { ...input, locale: resolveLocale(undefined, req.headers['accept-language']) },
    sessionContext(req),
  );
  sessionResponse(res, session);
}

export async function login(req: Request, res: Response) {
  const input = loginSchema.parse(req.body);
  try {
    // Express's `req.ip` honours the `trust proxy` setting (app.ts) — it is
    // the whole reason the throttle keys on the IP the client believes it
    // is, rather than Render's proxy address (see config.trustProxy).
    const session = await authService.login({ ...input, ip: req.ip }, sessionContext(req));
    sessionResponse(res, session);
  } catch (err) {
    // Phase 8, issue #35: a throttled attempt must tell the client how long
    // to wait, both as a header and in the message (see LoginThrottledError).
    if (err instanceof authService.LoginThrottledError) {
      res.set('Retry-After', String(err.retryAfterSeconds));
    }
    throw err;
  }
}

/** Admin-only: clear a login lock/throttle bucket for an account or an IP.
 * Writes an audit line to the server log. Not wired into AuditEvent yet
 * (issue #43 covered booking, doctor verification and payments only — see
 * ARCHITECTURE.md §6.2.4), so this is the interim record. */
export async function clearLoginAttempts(req: Request, res: Response) {
  const { email, ip } = clearLoginAttemptsSchema.parse(req.body);
  const cleared = await authService.clearLoginAttempts({ email, ip });
  // eslint-disable-next-line no-console
  console.info(`[auth] admin ${req.user?.id ?? 'unknown'} cleared ${cleared} login-throttle bucket(s) (email=${email ?? '-'} ip=${ip ?? '-'})`);
  res.status(200).json({ cleared });
}

/**
 * Admin invite redemption (Phase 8, issue #39). Lives in the auth module
 * because it ends in a session, but the invite itself is the users module's
 * business — see `authService.signupWithInvite`, which calls that module's
 * service rather than touching its tables.
 */
export async function signupWithInvite(req: Request, res: Response) {
  const input = signupWithInviteSchema.parse(req.body);
  const session = await authService.signupWithInvite(input, sessionContext(req));
  sessionResponse(res, session);
}

export async function refresh(req: Request, res: Response) {
  const token = refreshCookieValue(req);
  if (!token) throw new HttpError(401, 'No refresh token provided.');

  const session = await authService.refresh(token, readCsrfHeader(req));
  sessionResponse(res, session);
}

// Phase 8, issue #34.
export async function verifyEmail(req: Request, res: Response) {
  const { token } = verifyEmailSchema.parse(req.body);
  const result = await authService.verifyEmail(token);
  res.status(200).json({ emailVerifiedAt: result.emailVerifiedAt });
}

/** Authenticated on purpose: the resend target is the caller's own
 * account, so this endpoint can't be used to enumerate registered
 * addresses, and being logged in is exactly the state a user is in when
 * they need it (login is allowed while unverified). */
export async function resendVerificationEmail(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const result = await authService.resendVerificationEmail(req.user.id);
  res.status(200).json(result);
}

/**
 * Clears the refresh cookie.
 *
 * Logout is cookie-authenticated too, so it needs the same CSRF treatment —
 * but there's no session token to bind a CSRF token to here (the request
 * carries no access token), so the enforced layers are the Origin allowlist
 * (`requireAllowedOrigin` on the route) plus the requirement that the
 * `X-CSRF-Token` header be present. A cross-site HTML form can set neither,
 * so a forged logout is refused before it clears anything. The worst case if
 * it weren't — a forced sign-out — is why this is the one route where a
 * presence check is enough rather than a value match.
 */
export function logout(req: Request, res: Response) {
  if (!readCsrfHeader(req)) {
    throw new HttpError(403, 'Missing CSRF token. Send the csrfToken from your login response in the X-CSRF-Token header.');
  }
  res.clearCookie(REFRESH_COOKIE, config.cookie);
  res.status(204).send();
}

// Both reset endpoints answer identically for known and unknown emails —
// same status, same body, no branch on the result of the lookup. Rate
// limiting is the one intentional exception (429), and it fires before any
// account lookup, so it can't leak existence either.
export async function requestPasswordReset(req: Request, res: Response) {
  const { email } = passwordResetRequestSchema.parse(req.body);
  await authService.requestPasswordReset({ email, ip: req.ip ?? 'unknown' });
  res.status(202).json({
    message: 'If an account exists for that email, a password reset link has been sent.',
  });
}

export async function confirmPasswordReset(req: Request, res: Response) {
  const input = passwordResetConfirmSchema.parse(req.body);
  await authService.confirmPasswordReset(input);
  // The reset already killed every refresh token for this user
  // (tokenVersion bump) — clear the caller's cookie too so a browser that
  // still holds the old one isn't left sending a dead token.
  res.clearCookie(REFRESH_COOKIE, config.cookie);
  res.status(200).json({ message: 'Password updated. Please sign in with your new password.' });
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
  if (result.wasCurrent) res.clearCookie(REFRESH_COOKIE, config.cookie);
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
