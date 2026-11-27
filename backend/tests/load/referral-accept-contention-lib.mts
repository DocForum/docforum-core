// Seeding and database invariants for the referral-accept contention load
// test (issue #349). Shared by the k6 seed/verify scripts in this directory
// and by tests/integration/referral-accept-contention.test.mts, so the
// invariants CI checks are the same ones a load run checks.
//
// Shape: one specialist with `slotCount` open slots, and `referralCount`
// patients, each holding one pending referral to that specialist (made from
// a real completed consultation with a GP). Every referral is assigned one
// of the specialist's slots round-robin, so several patients race for each
// slot when they accept at once.
import {
  consultationRitual,
  createReferral,
  generateSlots,
  makeDoctor,
  makePatient,
  type DoctorFixture,
} from '../integration/helpers/fixtures.mjs';

type App = ReturnType<typeof import('../../src/app.js').createApp>;
type PrismaClient = typeof import('../../src/db/prisma-client.js').prisma;

export interface ContentionSeed {
  targetDoctorId: string;
  slotIds: string[];
  referrals: { id: string; patientProfileId: string; patientToken: string; targetSlotId: string }[];
}

// A GP's generated day holds 24 half-hour slots and each consultation uses
// one, so spread patients across GPs well below that.
const PATIENTS_PER_GP = 20;

export async function seedReferralAcceptContention(
  app: App,
  prisma: PrismaClient,
  emailedTokens: Map<string, string>,
  options: { referralCount: number; slotCount: number; runId: number },
): Promise<ContentionSeed> {
  const { referralCount, slotCount, runId } = options;
  if (slotCount < 1 || referralCount < slotCount) {
    throw new Error('need at least one slot and at least as many referrals as slots');
  }

  const specialist = await makeDoctor(app, prisma, emailedTokens, runId);
  const generated = await generateSlots(app, specialist);
  if (generated.length < slotCount) throw new Error(`only ${generated.length} slots generated`);
  const slotIds = generated.slice(0, slotCount);
  // "A specialist with few slots": drop the rest of the generated day so no
  // request can land on an uncontended slot.
  await prisma.availabilitySlot.deleteMany({
    where: { doctorProfileId: specialist.profileId, id: { notIn: slotIds } },
  });

  const gps: DoctorFixture[] = [];
  const referrals: ContentionSeed['referrals'] = [];
  for (let i = 0; i < referralCount; i += 1) {
    if (i % PATIENTS_PER_GP === 0) gps.push(await makeDoctor(app, prisma, emailedTokens, runId));
    const gp = gps[gps.length - 1];
    const patient = await makePatient(app, emailedTokens, runId);
    const { consultationId } = await consultationRitual(app, patient, gp);
    const res = await createReferral(app, gp, {
      sourceConsultationId: consultationId,
      targetDoctorId: specialist.profileId,
      snapshotNotes: `Load-test referral ${i + 1}`,
    });
    if (res.status !== 201) throw new Error(`referral create failed: ${res.status} ${res.text}`);
    referrals.push({
      id: res.body.id as string,
      patientProfileId: patient.profileId,
      patientToken: patient.accessToken,
      targetSlotId: slotIds[i % slotCount],
    });
  }
  return { targetDoctorId: specialist.profileId, slotIds, referrals };
}

/** Returns every invariant violation found; an empty list means the run was
 * correct. Reads only the database, never HTTP responses. */
export async function verifyReferralAcceptContention(
  prisma: PrismaClient,
  seed: Pick<ContentionSeed, 'targetDoctorId' | 'slotIds' | 'referrals'>,
): Promise<{ violations: string[]; accepted: number; pending: number }> {
  const violations: string[] = [];
  const referralIds = seed.referrals.map((r) => r.id);
  const [referrals, appointments, slots] = await Promise.all([
    prisma.referral.findMany({ where: { id: { in: referralIds } } }),
    prisma.appointment.findMany({
      where: { OR: [{ availabilitySlotId: { in: seed.slotIds } }, { referralId: { in: referralIds } }] },
    }),
    prisma.availabilitySlot.findMany({ where: { id: { in: seed.slotIds } } }),
  ]);

  if (referrals.length !== referralIds.length) {
    violations.push(`expected ${referralIds.length} referrals, found ${referrals.length}`);
  }

  // No double-booked slot: at most one appointment per seeded slot, and a
  // slot is `booked` exactly when it carries one.
  for (const slot of slots) {
    const onSlot = appointments.filter((a) => a.availabilitySlotId === slot.id);
    if (onSlot.length > 1) violations.push(`slot ${slot.id} has ${onSlot.length} appointments`);
    if (onSlot.length === 1 && slot.status !== 'booked') violations.push(`slot ${slot.id} has an appointment but is ${slot.status}`);
    if (onSlot.length === 0 && slot.status !== 'open') violations.push(`slot ${slot.id} has no appointment but is ${slot.status}`);
  }

  let accepted = 0;
  let pending = 0;
  for (const referral of referrals) {
    const own = appointments.filter((a) => a.referralId === referral.id);
    if (referral.status === 'accepted') {
      accepted += 1;
      // Accepted with exactly one appointment, linked both ways, on one of
      // the specialist's seeded slots, for the referral's own patient.
      if (own.length !== 1) {
        violations.push(`accepted referral ${referral.id} has ${own.length} appointments`);
        continue;
      }
      const appt = own[0];
      if (referral.resultingAppointmentId !== appt.id) violations.push(`referral ${referral.id} does not point at its appointment`);
      if (appt.status !== 'scheduled') violations.push(`appointment ${appt.id} is ${appt.status}`);
      if (appt.origin !== 'referral') violations.push(`appointment ${appt.id} origin is ${appt.origin}`);
      if (appt.patientProfileId !== referral.patientProfileId) violations.push(`appointment ${appt.id} belongs to another patient`);
      if (appt.doctorProfileId !== seed.targetDoctorId) violations.push(`appointment ${appt.id} is with another doctor`);
      if (!appt.availabilitySlotId || !seed.slotIds.includes(appt.availabilitySlotId)) {
        violations.push(`appointment ${appt.id} is not on a seeded slot`);
      }
    } else if (referral.status === 'pending') {
      pending += 1;
      if (own.length !== 0) violations.push(`pending referral ${referral.id} has ${own.length} appointments`);
      if (referral.resultingAppointmentId !== null) violations.push(`pending referral ${referral.id} has a resulting appointment`);
    } else {
      violations.push(`referral ${referral.id} ended ${referral.status}, expected accepted or pending`);
    }
  }

  const strayAppointments = appointments.filter((a) => !a.referralId || !referralIds.includes(a.referralId));
  if (strayAppointments.length > 0) violations.push(`${strayAppointments.length} seeded slots were booked outside the referrals`);
  if (accepted > seed.slotIds.length) violations.push(`${accepted} referrals accepted into ${seed.slotIds.length} slots`);

  return { violations, accepted, pending };
}
