// Guardians and dependents (Phase 8, issue #42, docs/adr/0011). Guardian
// access ends automatically when the dependent reaches this age (UTC
// calendar date, checked at request time).
export const patients = {
  ageOfMajorityYears: Number(process.env.AGE_OF_MAJORITY_YEARS ?? 18),
} as const;
