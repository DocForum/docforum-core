export const cookie = {
  // The refresh cookie is `SameSite=None; Secure` in production because
  // docforum-web (GitHub Pages) and this API (Render) are genuinely
  // different sites — see docs/adr/0003. `Secure` needs HTTPS, which local
  // dev over plain http doesn't have, hence the NODE_ENV branch. Shared
  // with the CSRF cookie so the two can never drift apart.
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? ('none' as const) : ('lax' as const),
  path: '/',
} as const;
