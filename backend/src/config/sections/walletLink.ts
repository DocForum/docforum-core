// Facility payout-wallet change cool-down (issue #328). A facility that
// re-links its payout wallet keeps funding to the previously effective
// address for this many hours; the new address becomes the escrow payee
// only afterwards. The first-ever link for a facility (and every patient
// link) is immediate. 0 disables the cool-down (local development only).
// NaN for a malformed value, so startup validation can name the variable.
function parseCooldownHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 24;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours >= 0 ? hours : Number.NaN;
}

export const walletLink = {
  cooldownHours: parseCooldownHours(process.env.WALLET_LINK_COOLDOWN_HOURS),
} as const;
