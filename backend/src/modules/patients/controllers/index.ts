import type { Request, Response } from 'express';
import { once } from 'node:events';
import * as patientsService from '../services';
import { HttpError } from '../../../http-error';
import { getParam } from '../../../request-params';
import { deleteAccountSchema } from '../validation';
import { LoginThrottledError } from '../../auth/services';

// Phase 8, issue #40 — right of access. The subject is always `req.user`;
// no route here accepts a patient id.

export async function requestExport(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { export: view } = await patientsService.requestMyExport(req.user.id);
  res.set('Location', `/patients/me/export/${view.id}`);
  // 202 for a new job and for an already-running one alike: either way the
  // client polls the returned id.
  res.status(202).json(view);
}

export async function getExport(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const view = await patientsService.getMyExport(req.user.id, getParam(req, 'exportId'));
  res.status(200).json(view);
}

/** Streams the stored bundle chunk by chunk, honouring backpressure, so a
 * large export never sits in memory whole. */
export async function downloadExport(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const download = await patientsService.openMyExportDownload(req.user.id, getParam(req, 'exportId'));

  res.status(200);
  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(download.sizeBytes),
    'Content-Disposition': `attachment; filename="${download.filename}"`,
    'Cache-Control': 'no-store',
  });

  try {
    for await (const chunk of download.chunks()) {
      if (res.destroyed) return;
      // Wait for the socket to drain, or give up if the client went away.
      if (!res.write(chunk)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
    }
    res.end();
  } catch (err) {
    // Headers are already sent, so there's no error envelope to send: cut
    // the connection rather than end a truncated document cleanly.
    res.destroy(err instanceof Error ? err : new Error('EXPORT_STREAM_FAILED'));
  }
}

/** Phase 8, issue #41 — account deletion (docs/adr/0010). 204 whether this
 * call anonymised the account or it was already deleted (idempotent). */
export async function deleteMe(req: Request, res: Response) {
  if (!req.user) throw new HttpError(401, 'Authentication required.');
  const { password } = deleteAccountSchema.parse(req.body ?? {});
  try {
    await patientsService.deleteMyAccount(req.user.id, password, req.ip);
  } catch (err) {
    // Password re-confirmation shares the login throttle (issue #35).
    if (err instanceof LoginThrottledError) res.set('Retry-After', String(err.retryAfterSeconds));
    throw err;
  }
  res.status(204).send();
}
