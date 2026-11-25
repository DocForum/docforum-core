import 'dotenv/config';
import * as sections from './sections';

export type { PaymentAsset } from './sections/payments';
export type { JwtSigningKey } from './sections/jwt';
export { normalizedPhone } from './sections/notifications';

// The app's configuration, read from the environment once at startup. Each
// top-level key lives in its own file under sections/ (one per feature), so
// adding a setting doesn't make every open PR edit this file. A section is
// `export const <key> = { ... } as const;` in sections/<key>.ts, plus one
// line in sections/index.ts.
export const config = { ...sections } as const;
