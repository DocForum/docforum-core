// SEP-10 Stellar Web Authentication (issue #77, ADR 0005 step 4).
export const sep10 = {
  signingSecret: process.env.SEP10_SIGNING_SECRET,
  homeDomain: process.env.SEP10_HOME_DOMAIN,
  webAuthDomain: process.env.SEP10_WEB_AUTH_DOMAIN,
  networkPassphrase: process.env.SEP10_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
  horizonUrl: process.env.SEP10_HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
  challengeTimeoutSeconds: Number(process.env.SEP10_CHALLENGE_TIMEOUT_SECONDS ?? 300),
} as const;
