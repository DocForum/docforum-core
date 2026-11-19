import { requireEnv } from '../helpers';

export const port = Number(process.env.PORT ?? 4000);
export const databaseUrl = requireEnv('DATABASE_URL');

// Base URL of docforum-web, used to build the link in outbound
// notifications (password reset today). Not a provider decision — see
// issue #17 — just the URL the recipient is sent to.
export const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:5173';
