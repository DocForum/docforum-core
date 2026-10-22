// Age of majority (Phase 8, issue #42, docs/adr/0011). Pure date math, so
// it's unit-tested exhaustively instead of being re-derived at call sites.
//
// Convention: evaluated in UTC on the calendar date. A person reaches
// majority at 00:00 UTC on their Nth birthday; someone born on 29 February
// reaches it on 1 March in a non-leap year (their birthday doesn't exist
// that year, and they are not yet N on 28 February).

/** The instant (00:00 UTC) at which someone born on `dateOfBirth` turns
 * `years` old. */
export function majorityDate(dateOfBirth: Date, years: number): Date {
  const y = dateOfBirth.getUTCFullYear() + years;
  const m = dateOfBirth.getUTCMonth();
  const d = dateOfBirth.getUTCDate();
  // Date.UTC rolls 29 Feb of a non-leap year over to 1 Mar — the intended rule.
  return new Date(Date.UTC(y, m, d));
}

export function isMinor(dateOfBirth: Date, years: number, now: Date): boolean {
  return now.getTime() < majorityDate(dateOfBirth, years).getTime();
}
