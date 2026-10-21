import type { Prisma } from '@prisma/client';

let sequence = 0;
const next = () => ++sequence;
const nextEmail = (kind: string) => `${kind}-${next()}@example.test`;

export const userFactory = (overrides: Partial<Prisma.UserUncheckedCreateInput> = {}): Prisma.UserUncheckedCreateInput => ({
  email: nextEmail('user'),
  passwordHash: 'test-password-hash',
  role: 'patient',
  ...overrides,
});

export const patientProfileFactory = (
  userId: string,
  overrides: Partial<Prisma.PatientProfileUncheckedCreateInput> = {},
): Prisma.PatientProfileUncheckedCreateInput => ({ userId, fullName: `Test Patient ${next()}`, ...overrides });

export const doctorProfileFactory = (
  userId: string,
  overrides: Partial<Prisma.DoctorProfileUncheckedCreateInput> = {},
): Prisma.DoctorProfileUncheckedCreateInput => ({
  userId,
  fullName: `Test Doctor ${next()}`,
  verificationStatus: 'pending',
  ...overrides,
});

export const facilityProfileFactory = (
  userId: string,
  overrides: Partial<Prisma.FacilityProfileUncheckedCreateInput> = {},
): Prisma.FacilityProfileUncheckedCreateInput => ({ userId, name: `Test Facility ${next()}`, type: 'lab', ...overrides });

export const specialtyFactory = (overrides: Partial<Prisma.SpecialtyCreateInput> = {}): Prisma.SpecialtyCreateInput => {
  const name = `Test Specialty ${next()}`;
  return { name, slug: name.toLowerCase().replaceAll(' ', '-'), ...overrides };
};

export const doctorSpecialtyFactory = (
  doctorProfileId: string,
  specialtyId: string,
  overrides: Partial<Prisma.DoctorSpecialtyUncheckedCreateInput> = {},
): Prisma.DoctorSpecialtyUncheckedCreateInput => ({ doctorProfileId, specialtyId, ...overrides });

export const facilityCapabilityFactory = (
  facilityProfileId: string,
  overrides: Partial<Prisma.FacilityCapabilityUncheckedCreateInput> = {},
): Prisma.FacilityCapabilityUncheckedCreateInput => ({
  facilityProfileId,
  capabilityType: 'lab_test',
  detail: `test-capability-${next()}`,
  ...overrides,
});

export const availabilitySlotFactory = (
  doctorProfileId: string,
  overrides: Partial<Prisma.AvailabilitySlotUncheckedCreateInput> = {},
): Prisma.AvailabilitySlotUncheckedCreateInput => {
  const startTime = new Date(Date.now() + 24 * 60 * 60 * 1_000 + next() * 60_000);
  return {
    doctorProfileId,
    status: 'open',
    startTime,
    endTime: new Date(startTime.getTime() + 30 * 60_000),
    ...overrides,
  };
};

export const appointmentFactory = (
  patientProfileId: string,
  doctorProfileId: string,
  availabilitySlotId: string | null,
  overrides: Partial<Prisma.AppointmentUncheckedCreateInput> = {},
): Prisma.AppointmentUncheckedCreateInput => ({
  patientProfileId,
  doctorProfileId,
  availabilitySlotId,
  status: 'scheduled',
  origin: 'direct_booking',
  referralId: null,
  ...overrides,
});

export const paymentIntentFactory = (
  patientProfileId: string,
  facilityId: string,
  order: { kind: 'prescription'; id: string } | { kind: 'lab_order'; id: string },
  overrides: Partial<Prisma.PaymentIntentUncheckedCreateInput> = {},
): Prisma.PaymentIntentUncheckedCreateInput => ({
  patientProfileId,
  facilityId,
  prescriptionId: order.kind === 'prescription' ? order.id : null,
  labOrderId: order.kind === 'lab_order' ? order.id : null,
  status: 'created',
  amountStroops: 1_000n,
  ...overrides,
});

export const walletLinkFactory = (
  facilityId: string,
  overrides: Partial<Prisma.WalletLinkUncheckedCreateInput> = {},
): Prisma.WalletLinkUncheckedCreateInput => ({
  facilityId,
  stellarPublicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  ...overrides,
});
