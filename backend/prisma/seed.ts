// Dev/test seed — issue #74: "Seed realistic test locations (no real
// facilities' private data)."
//
// Every facility here is fictional: made-up names, generic area-level
// addresses, and coordinates that point at well-known public areas in
// Lagos, Nigeria — not at any real pharmacy or lab. Two entries
// deliberately have NO coordinates, to exercise the "facilities without
// coordinates still appear, sorted last" behavior of
// GET /facilities/eligible.
//
// Run with: npx prisma db seed   (or: npx tsx prisma/seed.ts)
// Idempotent: upserts by email / (facilityProfileId, capabilityType,
// detail), so re-running it doesn't duplicate anything.
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

// Prisma 7 (issue #47/ADR 0006): the client requires a driver adapter —
// the bare `new PrismaClient()` of Prisma 6 throws at connect time. Same
// construction as src/db/prisma-client.ts, reading the connection string
// from DATABASE_URL.
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5_000,
  }),
});

// Dev-only password. The seed never runs in production; these accounts
// exist so a developer can log in as a facility without an admin-invite
// flow (which is issue #14's scope).
const SEED_PASSWORD_HASH = bcrypt.hashSync('seed-dev-password-123', 10);

interface SeedFacility {
  email: string;
  name: string;
  type: 'pharmacy' | 'lab';
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  capabilities: { capabilityType: 'lab_test' | 'medication_dispense'; detail: string }[];
}

const facilities: SeedFacility[] = [
  {
    email: 'pharmacy.ikeja@example.test',
    name: 'Ikeja Community Pharmacy (seed)',
    type: 'pharmacy',
    address: 'Ikeja GRA, Lagos',
    latitude: 6.5833,
    longitude: 3.3564,
    capabilities: [
      { capabilityType: 'medication_dispense', detail: 'general' },
      { capabilityType: 'medication_dispense', detail: 'antibiotics' },
    ],
  },
  {
    email: 'pharmacy.yaba@example.test',
    name: 'Yaba Mainland Pharmacy (seed)',
    type: 'pharmacy',
    address: 'Yaba, Lagos',
    latitude: 6.5095,
    longitude: 3.3711,
    capabilities: [{ capabilityType: 'medication_dispense', detail: 'general' }],
  },
  {
    email: 'pharmacy.lekki@example.test',
    name: 'Lekki Phase 1 Pharmacy (seed)',
    type: 'pharmacy',
    address: 'Lekki Phase 1, Lagos',
    latitude: 6.4478,
    longitude: 3.4723,
    capabilities: [
      { capabilityType: 'medication_dispense', detail: 'general' },
      { capabilityType: 'medication_dispense', detail: 'chronic-care' },
    ],
  },
  {
    email: 'lab.surulere@example.test',
    name: 'Surulere Diagnostic Lab (seed)',
    type: 'lab',
    address: 'Surulere, Lagos',
    latitude: 6.4933,
    longitude: 3.3547,
    capabilities: [
      { capabilityType: 'lab_test', detail: 'malaria' },
      { capabilityType: 'lab_test', detail: 'full-blood-count' },
    ],
  },
  {
    email: 'lab.ikoyi@example.test',
    name: 'Ikoyi Health Lab (seed)',
    type: 'lab',
    address: 'Ikoyi, Lagos',
    latitude: 6.4541,
    longitude: 3.4318,
    capabilities: [{ capabilityType: 'lab_test', detail: 'malaria' }],
  },
  {
    email: 'pharmacy.ajah@example.test',
    name: 'Ajah Roadside Pharmacy (seed)',
    type: 'pharmacy',
    address: 'Ajah, Lagos',
    latitude: 6.4667,
    longitude: 3.5667,
    capabilities: [{ capabilityType: 'medication_dispense', detail: 'general' }],
  },
  // No coordinates on purpose — see file header.
  {
    email: 'pharmacy.no-location@example.test',
    name: 'Unnamed Island Pharmacy (seed, no coordinates)',
    type: 'pharmacy',
    address: null,
    latitude: null,
    longitude: null,
    capabilities: [{ capabilityType: 'medication_dispense', detail: 'general' }],
  },
  {
    email: 'lab.no-location@example.test',
    name: 'Unnamed Mobile Lab (seed, no coordinates)',
    type: 'lab',
    address: null,
    latitude: null,
    longitude: null,
    capabilities: [{ capabilityType: 'lab_test', detail: 'malaria' }],
  },
];

async function main() {
  for (const facility of facilities) {
    const user = await prisma.user.upsert({
      where: { email: facility.email },
      create: {
        email: facility.email,
        passwordHash: SEED_PASSWORD_HASH,
        role: 'facility',
        // Seed accounts skip the email-verification guard locally — the
        // email provider (Phase 6, issue #17) doesn't exist yet, so a
        // verification link can't be delivered. See
        // backend/src/modules/auth/services/email-dispatcher.ts.
        emailVerifiedAt: new Date(),
      },
      update: {},
    });

    const profile = await prisma.facilityProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        name: facility.name,
        type: facility.type,
        address: facility.address,
        latitude: facility.latitude,
        longitude: facility.longitude,
      },
      update: {
        name: facility.name,
        type: facility.type,
        address: facility.address,
        latitude: facility.latitude,
        longitude: facility.longitude,
      },
    });

    for (const capability of facility.capabilities) {
      await prisma.facilityCapability.upsert({
        where: {
          facilityProfileId_capabilityType_detail: {
            facilityProfileId: profile.id,
            capabilityType: capability.capabilityType,
            detail: capability.detail,
          },
        },
        create: {
          facilityProfileId: profile.id,
          capabilityType: capability.capabilityType,
          detail: capability.detail,
        },
        update: {},
      });
    }
  }
  console.log(`Seeded ${facilities.length} fictional facilities.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
