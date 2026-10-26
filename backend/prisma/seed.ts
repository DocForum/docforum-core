import bcrypt from 'bcryptjs';
import { prisma } from '../src/db/prisma-client.js';
import {
  availabilitySlotFactory,
  doctorProfileFactory,
  doctorSpecialtyFactory,
  facilityCapabilityFactory,
  facilityProfileFactory,
  patientProfileFactory,
  specialtyFactory,
  userFactory,
  walletLinkFactory,
} from '../tests/factories/index.js';

const seedPassword = process.env.DEMO_SEED_PASSWORD;
if (!seedPassword || seedPassword.length < 12) {
  throw new Error('Set DEMO_SEED_PASSWORD to a password of at least 12 characters.');
}
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SYNTHETIC_SEED !== 'true') {
  throw new Error('Synthetic seeding in production requires ALLOW_SYNTHETIC_SEED=true.');
}

async function upsertUser(email: string, role: 'admin' | 'doctor' | 'patient' | 'facility') {
  const passwordHash = await bcrypt.hash(seedPassword!, 12);
  const data = userFactory({ email, role, passwordHash, emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z') });
  return prisma.user.upsert({ where: { email }, create: data, update: { role, passwordHash } });
}

async function seed() {
  const admin = await upsertUser('admin@docforum.example.test', 'admin');
  const patient = await upsertUser('patient@docforum.example.test', 'patient');
  const facilityUser = await upsertUser('facility@docforum.example.test', 'facility');
  await prisma.patientProfile.upsert({
    where: { userId: patient.id },
    create: patientProfileFactory(patient.id, { fullName: 'Synthetic Patient' }),
    update: { fullName: 'Synthetic Patient' },
  });

  const specialties = await Promise.all(
    [
      specialtyFactory({ name: 'Cardiology', slug: 'cardiology' }),
      specialtyFactory({ name: 'Dermatology', slug: 'dermatology' }),
      specialtyFactory({ name: 'Family Medicine', slug: 'family-medicine' }),
    ].map((specialty) => prisma.specialty.upsert({
      where: { slug: specialty.slug },
      create: specialty,
      update: { name: specialty.name },
    })),
  );

  const doctors = [
    { email: 'doctor.cardiology@docforum.example.test', name: 'Synthetic Cardiology Doctor', specialty: specialties[0] },
    { email: 'doctor.dermatology@docforum.example.test', name: 'Synthetic Dermatology Doctor', specialty: specialties[1] },
    { email: 'doctor.family@docforum.example.test', name: 'Synthetic Family Doctor', specialty: specialties[2] },
  ];
  for (const [index, entry] of doctors.entries()) {
    const user = await upsertUser(entry.email, 'doctor');
    const doctor = await prisma.doctorProfile.upsert({
      where: { userId: user.id },
      create: doctorProfileFactory(user.id, { fullName: entry.name, verificationStatus: 'verified' }),
      update: { fullName: entry.name, verificationStatus: 'verified' },
    });
    await prisma.doctorSpecialty.upsert({
      where: { doctorProfileId_specialtyId: { doctorProfileId: doctor.id, specialtyId: entry.specialty.id } },
      create: doctorSpecialtyFactory(doctor.id, entry.specialty.id),
      update: {},
    });

    const slots = [];
    for (let day = 1; day <= 14; day += 1) {
      const date = new Date();
      date.setUTCHours(0, 0, 0, 0);
      date.setUTCDate(date.getUTCDate() + day);
      if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
      for (let hour = 9; hour < 12; hour += 1) {
        const startTime = new Date(date);
        startTime.setUTCHours(hour);
        slots.push(availabilitySlotFactory(doctor.id, {
          startTime,
          endTime: new Date(startTime.getTime() + 30 * 60_000),
        }));
      }
    }
    await prisma.availabilitySlot.createMany({ data: slots, skipDuplicates: true });
  }

  const facility = await prisma.facilityProfile.upsert({
    where: { userId: facilityUser.id },
    create: facilityProfileFactory(facilityUser.id, { name: 'Synthetic Pharmacy', type: 'pharmacy' }),
    update: { name: 'Synthetic Pharmacy', type: 'pharmacy' },
  });
  const capability = facilityCapabilityFactory(facility.id, {
    capabilityType: 'medication_dispense',
    detail: 'synthetic medication capability',
  });
  const existingCapability = await prisma.facilityCapability.findFirst({ where: capability });
  if (!existingCapability) await prisma.facilityCapability.create({ data: capability });
  await prisma.walletLink.upsert({
    where: { activeOwnerKey: `facility:${facility.id}` },
    create: walletLinkFactory(facility.id),
    update: {},
  });

  // The seed identity is synthetic and must never receive funds. The account
  // is retained as an explicitly non-spendable display fixture only.
  console.log(`Seeded synthetic DocForum data (admin ${admin.email}; patient ${patient.email}).`);
}

void seed()
  .catch((error: unknown) => {
    console.error('Synthetic seed failed:', error instanceof Error ? error.message : typeof error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
