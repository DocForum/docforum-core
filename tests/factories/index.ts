import type { PrismaClient, Prisma } from "@prisma/client";

export type ReferralFactoryOverrides = Partial<Prisma.ReferralUncheckedCreateInput>;

/**
 * Builds ReferralUncheckedCreateInput values for seeding load-test data.
 * The referral model in the Prisma schema does not have a `doctorProfileId`
 * field, so the target specialist is expressed through the fields the schema
 * actually defines. Callers that need a specific target must pass the field
 * names from ReferralUncheckedCreateInput (see prisma/schema.prisma).
 */
export function buildReferralData(
  patientId: string,
  overrides: ReferralFactoryOverrides = {},
): Prisma.ReferralUncheckedCreateInput {
  return {
    patientId,
    status: "PENDING",
    ...overrides,
  } as Prisma.ReferralUncheckedCreateInput;
}

export async function createReferrals(
  prisma: PrismaClient,
  patientIds: string[],
  overrides: ReferralFactoryOverrides = {},
) {
  const rows = patientIds.map((id) => buildReferralData(id, overrides));
  const created = [];
  for (const row of rows) {
    created.push(await prisma.referral.create({ data: row }));
  }
  return created;
}
