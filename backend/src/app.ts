import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { errorHandler } from './middleware/error-handler';
import { registerPatientExportSections } from './export-sections';
import { requestId } from './middleware/request-id';
import * as moduleMounts from './mounts';
import { registerRetentionHolds } from './retention-holds';
import { getReadiness } from './health/readiness';
import { runWithRlsContext } from './db/prisma-client';
import { join } from 'node:path';
import * as authService from './modules/auth/services';
import { createPostmarkAdapter } from './modules/notifications/channels/postmark';
import { createTwilioAdapter } from './modules/notifications/channels/twilio';
import * as notificationsService from './modules/notifications/services';

let notificationAdaptersRegistered = false;

export function createApp() {
  const app = express();

  // Phase 8, issue #40: idempotent, so building the app twice is harmless.
  registerPatientExportSections();
  // Phase 8, issue #41: idempotent, so building the app twice is harmless.
  registerRetentionHolds();
  // Provider adapters receive recipients through auth's exported service;
  // they never cross the module boundary into the User repository.
  if (!notificationAdaptersRegistered) {
    notificationsService.registerChannelAdapter(createPostmarkAdapter(async (id) => (await authService.getNotificationRecipient(id))?.email ?? null));
    notificationsService.registerChannelAdapter(createTwilioAdapter(async (id) => (await authService.getNotificationRecipient(id))?.phone ?? null));
    notificationAdaptersRegistered = true;
  }

  // Phase 8, issue #35: login throttling keys on the client IP, so the
  // proxy chain has to be resolved deliberately rather than guessed. See
  // config.trustProxy for why neither `true` nor the default is safe here.
  app.set('trust proxy', config.trustProxy);

  // Explicit allowlist per environment (Phase 8, issue #37) — see
  // config.corsOrigins. `credentials: true` is required for the refresh
  // cookie and is exactly why the allowlist can't be a wildcard.
  // Phase 8, issue #43: first, so every response (errors included) carries
  // an X-Request-Id and audit events can be tied back to it. Phase 9,
  // issue #46: the same middleware attaches a request-scoped child logger
  // (`req.log`) so every log line in a request can be greped by that id.
  app.use(requestId);
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());
  // Unauthenticated requests must not inherit a previous patient's identity.
  // Authenticated routes replace this with the verified JWT context.
  app.use((_req, _res, next) => runWithRlsContext({ userId: '', role: 'anonymous' }, next));

  app.get('/health/live', (_req, res) => res.status(200).json({ status: 'live' }));
  app.get('/health/ready', async (_req, res) => {
    const readiness = await getReadiness();
    res.status(readiness.status === 'ready' ? 200 : 503).json(readiness);
  });
  // Keep the original liveness path for existing monitors and clients.
  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
  if (config.notifications.openapi.expose) {
    app.get('/openapi.json', (_req, res) => res.sendFile(join(process.cwd(), process.cwd().endsWith('/backend') ? 'openapi.json' : 'backend/openapi.json')));
  }

  // Each module mounts its own routes (src/mounts.ts, one line per module).
  for (const mount of Object.values(moduleMounts)) mount(app);

  // Must be registered last — Express only routes errors here once every
  // other handler has had a chance to run.
  app.use(errorHandler);

  return app;
}
