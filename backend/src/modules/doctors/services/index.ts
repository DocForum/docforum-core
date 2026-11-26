import { HttpError } from '../../../http-error';
import { versionConflict } from '../../../middleware/optimistic-concurrency';
import { prisma } from '../../../db/prisma-client';
import * as auditService from '../../audit/services';
import * as availabilityService from '../../availability/services';
import * as doctorsRepo from '../repositories';
import type { Prisma, VerificationStatus } from '@prisma/client';
type DbClient = typeof prisma | Prisma.TransactionClient;

export async function getMyDoctorProfile(userId: string) {
  const profile = await doctorsRepo.findDoctorProfileByUserId(userId);
  if (!profile) throw new HttpError(404, 'No doctor profile for this account.');
  return profile;
}

export async function updateMyDoctorProfile(
  userId: string,
  version: number,
  input: { fullName?: string; timeZone?: string },
) {
  const current = await getMyDoctorProfile(userId);
  const profile = await doctorsRepo.updateDoctorProfile(current.id, version, input);
  if (!profile) throw versionConflict();
  return profile;
}

export function listSpecialties(options: { includeRetired?: boolean } = {}) {
  return doctorsRepo.findSpecialties(options);
}

export async function listPublicDoctors(input: {
  specialty?: string;
  q?: string;
  symptom?: string;
  limit: number;
  cursor?: string;
  availableBefore?: Date;
}) {
  let eligibleDoctorIds: string[] | null = null;
  if (input.availableBefore) {
    eligibleDoctorIds = await availabilityService.getDoctorIdsWithAvailableSlotsBefore(input.availableBefore);
    if (eligibleDoctorIds.length === 0) {
      return { items: [], nextCursor: null };
    }
  }

  // Issue #60: `?symptom=` resolves the curated mapping to weighted
  // specialties and ranks doctors by the strongest mapping they hold. An
  // unknown or unmapped symptom is an empty result plus a hint — never a
  // 404, because "we don't know that complaint" is not a client error.
  let ranked: Array<{ id: string; fullName: string; score: number }>;
  let hint: string | undefined;
  if (input.symptom) {
    const symptom = await doctorsRepo.findSymptomBySlug(input.symptom.toLowerCase());
    if (!symptom || symptom.isRetired) {
      return {
        items: [],
        nextCursor: null,
        hint: 'Unknown symptom. Use GET /symptoms?q= to find a supported complaint.',
      };
    }
    if (symptom.specialties.length === 0) {
      return {
        items: [],
        nextCursor: null,
        hint: `No specialties are mapped to "${symptom.name}" yet.`,
      };
    }
    ranked = await doctorsRepo.searchVerifiedDoctorIdsForSymptom({
      symptomId: symptom.id,
      cursor: input.cursor ?? null,
      take: input.limit + 1,
      doctorIds: eligibleDoctorIds,
    });
    if (ranked.length === 0) {
      hint = `No verified doctors currently list a specialty mapped to "${symptom.name}".`;
    }
  } else {
    ranked = await doctorsRepo.searchVerifiedDoctorIds({
      query: input.q ?? null,
      specialtySlug: input.specialty ?? null,
      cursor: input.cursor ?? null,
      take: input.limit + 1,
      doctorIds: eligibleDoctorIds,
    });
  }
  const hasMore = ranked.length > input.limit;
  const page = ranked.slice(0, input.limit);
  const details = await doctorsRepo.findPublicDoctorDetails(page.map((doctor) => doctor.id));
  const detailsById = new Map(details.map((doctor) => [doctor.id, doctor]));

  // Batch query next available slot for all doctors on this page
  const nextSlots = await availabilityService.getNextAvailableSlots(page.map((d) => d.id));

  return {
    items: page.flatMap((rankedDoctor) => {
      const doctor = detailsById.get(rankedDoctor.id);
      if (!doctor) return [];
      const nextSlot = nextSlots.get(doctor.id);
      return [{
        id: doctor.id,
        fullName: doctor.fullName,
        specialties: doctor.specialties.map((assignment) => assignment.specialty),
        nextAvailableAt: nextSlot ? nextSlot.toISOString() : null,
      }];
    }),
    nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
    ...(hint ? { hint } : {}),
  };
}

export async function getPublicDoctor(doctorProfileId: string) {
  const details = await doctorsRepo.findPublicDoctorDetails([doctorProfileId]);
  const doctor = details[0];
  if (!doctor) {
    throw new HttpError(404, 'Doctor not found.');
  }
  const nextSlots = await availabilityService.getNextAvailableSlots([doctor.id]);
  const nextSlot = nextSlots.get(doctor.id);
  return {
    id: doctor.id,
    fullName: doctor.fullName,
    specialties: doctor.specialties.map((assignment) => assignment.specialty),
    nextAvailableAt: nextSlot ? nextSlot.toISOString() : null,
  };
}

export async function setMySpecialties(userId: string, requestedIds: string[]) {
  const specialtyIds = [...new Set(requestedIds)];
  return prisma.$transaction(async (tx) => {
    const profile = await doctorsRepo.findDoctorProfileByUserId(userId, tx);
    if (!profile) throw new HttpError(404, 'No doctor profile for this account.');

    const specialties = await doctorsRepo.findSpecialtiesByIds(specialtyIds, tx);
    if (specialties.length !== specialtyIds.length) {
      throw new HttpError(400, 'One or more specialty ids are unknown.');
    }

    // Check existing specialties for this doctor (issue #279, #282)
    const existing = await tx.doctorSpecialty.findMany({
      where: { doctorProfileId: profile.id },
      select: { specialtyId: true },
    });
    const existingIds = new Set(existing.map((e) => e.specialtyId));

    // Retired specialties cannot be newly assigned (issue #282).
    // Pre-existing doctor links to retired specialties remain valid.
    const newSpecialties = specialties.filter((s) => !existingIds.has(s.id));
    const retiredNew = newSpecialties.find((s) => s.isRetired);
    if (retiredNew) {
      throw new HttpError(400, `Cannot assign retired specialty: ${retiredNew.name}.`);
    }

    // Note on pending referrals (issue #279):
    // Removing a specialty that has pending referrals routed by it does not
    // alter or reroute those referrals. They remain assigned to the doctor and
    // must be handled or explicitly reassigned by an admin.
    await doctorsRepo.replaceDoctorSpecialties(tx, profile.id, specialtyIds);
    return { specialties: specialties.sort((a, b) => a.name.localeCompare(b.name)) };
  });
}

export async function getDoctorProfileById(doctorProfileId: string, db?: DbClient) {
  const profile = await doctorsRepo.findDoctorProfileById(doctorProfileId, db);
  if (!profile) throw new HttpError(404, 'Doctor profile not found.');
  return profile;
}

/** Batch id -> { id, fullName } lookup for other modules (patient data
 * export, issue #40). Public-facing fields only. */
export async function getDoctorSummariesByIds(ids: string[]): Promise<Map<string, { id: string; fullName: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await doctorsRepo.findDoctorSummariesByIds([...new Set(ids)]);
  return new Map(rows.map((row) => [row.id, { id: row.id, fullName: row.fullName }]));
}

/** Only a doctor acting on their own profile may generate slots for it —
 * no admin-on-behalf-of override in Phase 1. */
export async function assertOwnsDoctorProfile(userId: string, doctorProfileId: string) {
  const profile = await getDoctorProfileById(doctorProfileId);
  if (profile.userId !== userId) {
    throw new HttpError(403, 'You can only manage your own doctor profile.');
  }
  return profile;
}

/**
 * Doctor verification: manual, admin-gated (PRD §6.1 FR-3 — "verification
 * workflow is manual/admin-gated in v1"). No automated verification
 * pipeline exists or is planned for v1; this is intentionally just a
 * status flip an admin performs after some out-of-band check.
 *
 * Phase 8, issue #43: the flip and its AuditEvent (who, from, to) commit
 * together. Setting the status it already has is not a transition — it
 * returns the profile unchanged and records nothing.
 */
export async function setVerificationStatus(
  actor: auditService.AuditActor,
  doctorProfileId: string,
  status: VerificationStatus,
) {
  return prisma.$transaction(async (tx) => {
    const current = await doctorsRepo.lockVerificationStatus(tx, doctorProfileId);
    if (current === null) throw new HttpError(404, 'Doctor profile not found.');
    if (current === status) {
      return (await doctorsRepo.findDoctorProfileById(doctorProfileId, tx))!;
    }
    const profile = await doctorsRepo.updateVerificationStatus(tx, doctorProfileId, status);
    await auditService.record(tx, actor, {
      entityType: 'DoctorProfile',
      entityId: doctorProfileId,
      action: 'doctor.verification_status_changed',
      fromState: current,
      toState: status,
    });
    return profile;
  });
}

/** A referral target (or admin-reassignment target) must be a verified
 * doctor — an unverified profile has no business receiving patients
 * (issue #68: reassignment goes through this gate, never around it). */
export async function assertDoctorVerified(doctorProfileId: string) {
  const profile = await getDoctorProfileById(doctorProfileId);
  if (profile.verificationStatus !== 'verified') {
    throw new HttpError(422, 'Target doctor is not verified.');
  }
  return profile;
}

/**
 * Issue #68: the reassignment target must be verified AND actually hold
 * the referral's target specialty. Checked through this module's own
 * repository — callers (referrals/admin ops) never touch DoctorSpecialty
 * directly (module-boundary hard rule).
 */
export async function assertDoctorVerifiedInSpecialty(doctorProfileId: string, specialtyId: string) {
  const profile = await assertDoctorVerified(doctorProfileId);
  const specialties = await doctorsRepo.findDoctorSpecialties(doctorProfileId);
  const holds = specialties.some((link) => link.specialtyId === specialtyId);
  if (!holds) {
    throw new HttpError(422, 'Target doctor does not hold the referral’s specialty.');
  }
  return profile;
}

/**
 * Ensures the doctor's user account is active (not deactivated or deleted).
 * Throws 409 if the doctor's account is deactivated or deleted, since the
 * doctor cannot accept new bookings in that state.
 */
export async function assertDoctorActive(doctorProfileId: string, db?: DbClient) {
  const profile = await getDoctorProfileById(doctorProfileId, db);
  if (profile.user.deactivatedAt || profile.user.deletedAt) {
    throw new HttpError(409, 'Doctor is not available for booking.');
  }
  return profile;
}

/** Throws 422 when `specialtyId` names no specialty in the catalog. Lets
 * callers (referral creation, issue #334) give a specific message instead of
 * relying on a foreign-key failure or a misleading downstream error. */
export async function assertSpecialtyExists(specialtyId: string) {
  const specialty = await doctorsRepo.findSpecialtyById(specialtyId);
  if (!specialty) {
    throw new HttpError(422, 'The target specialty does not exist.', 'SPECIALTY_NOT_FOUND');
  }
  return specialty;
}

/** Doctor's specialty ids — used by referral creation to denormalise the
 * target specialty onto the referral for the loop guard. */
export async function listDoctorSpecialtyIds(doctorProfileId: string) {
  const specialties = await doctorsRepo.findDoctorSpecialties(doctorProfileId);
  return specialties.map((link) => link.specialtyId);
}

/**
 * Eligible recipients for a specialty-only referral (issue #6, ADR 0008):
 * verified doctors holding the specialty, excluding the given ids (the
 * referring doctor, plus anything the caller has already targeted in the
 * same batch) and doctors whose account is deactivated. The referrals
 * module decides *which* of these receives the referral — this module
 * only owns the definition of eligibility, so the manual and routed
 * paths cannot drift apart.
 */
export async function listEligibleReferralTargets(specialtyId: string, excludeDoctorProfileIds: string[] = []) {
  const rows = await doctorsRepo.findEligibleDoctorsForSpecialty(specialtyId, excludeDoctorProfileIds);
  return rows.map((row) => row.doctorProfileId);
}

/** Count and oldest-item age for the admin overview (issue #123). No PHI. */
export async function doctorVerificationQueueCounts() {
  const stats = await doctorsRepo.findPendingVerificationStats();
  const oldestAgeSeconds = stats.oldestCreatedAt
    ? Math.max(0, Math.floor((Date.now() - stats.oldestCreatedAt.getTime()) / 1000))
    : null;
  return { count: stats.count, oldestAgeSeconds };
}

export async function setDoctorSpecialtyVerification(
  actor: auditService.AuditActor,
  reviewerUserId: string,
  doctorProfileId: string,
  specialtyId: string,
  status: VerificationStatus,
  rejectionReason?: string,
) {
  return prisma.$transaction(async (tx) => {
    const assignment = await tx.doctorSpecialty.findUnique({
      where: { doctorProfileId_specialtyId: { doctorProfileId, specialtyId } },
      include: { specialty: true },
    });
    if (!assignment) {
      throw new HttpError(404, 'Doctor does not have this specialty assigned.');
    }
    // Same-status updates must be a no-op without an event, matching setVerificationStatus.
    if (assignment.verificationStatus === status) {
      return assignment;
    }
    const updated = await doctorsRepo.updateDoctorSpecialtyVerification(
      tx,
      doctorProfileId,
      specialtyId,
      status,
      reviewerUserId,
      status === 'rejected' ? (rejectionReason ?? null) : null,
    );
    await auditService.record(tx, actor, {
      entityType: 'DoctorSpecialty',
      entityId: assignment.id,
      action: 'doctor_specialty.verification_changed',
      fromState: assignment.verificationStatus,
      toState: status,
      metadata: {
        doctorProfileId,
        specialtyId,
        ...(status === 'rejected' && rejectionReason ? { rejectionReason } : {}),
      },
    });
    return updated;
  });
}

export interface VerificationQueueFilters {
  kind?: 'profile' | 'specialty';
  specialty?: string;
  limit: number;
  cursor?: string;
}

export interface VerificationQueueItem {
  id: string;
  kind: 'profile' | 'specialty';
  doctorProfileId: string;
  doctorName: string;
  name: string;
  specialty?: { id: string; name: string; slug: string };
  requestedSpecialties: Array<{ id: string; name: string; slug: string }>;
  createdAt: string;
  ageSeconds: number;
  isDeactivated: boolean;
  deactivated: boolean;
}

export function encodeQueueCursor(item: { createdAt: Date | string; id: string }): string {
  const d = item.createdAt instanceof Date ? item.createdAt : new Date(item.createdAt);
  return Buffer.from(`${d.toISOString()}|${item.id}`, 'utf8').toString('base64url');
}

export function decodeQueueCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.indexOf('|');
  const createdAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (separator < 1 || Number.isNaN(createdAt.getTime()) || !id) {
    throw new HttpError(400, 'Invalid cursor.', 'INVALID_CURSOR');
  }
  return { createdAt, id };
}

export async function getVerificationQueue(filters: VerificationQueueFilters) {
  const after = filters.cursor ? decodeQueueCursor(filters.cursor) : undefined;
  const take = filters.limit + 1;
  const now = Date.now();

  const profileItemsPromise =
    filters.kind === 'specialty'
      ? Promise.resolve([])
      : doctorsRepo.findPendingDoctorProfilesForQueue({
          specialty: filters.specialty,
          after,
          take,
        });

  const specialtyItemsPromise =
    filters.kind === 'profile'
      ? Promise.resolve([])
      : doctorsRepo.findPendingDoctorSpecialtiesForQueue({
          specialty: filters.specialty,
          after,
          take,
        });

  const [profiles, specialties] = await Promise.all([profileItemsPromise, specialtyItemsPromise]);

  const mappedProfiles: Array<VerificationQueueItem & { _sortDate: Date }> = profiles.map((p) => {
    const ageSeconds = Math.max(0, Math.floor((now - p.createdAt.getTime()) / 1000));
    const isDeactivated = Boolean(p.user?.deactivatedAt);
    return {
      id: p.id,
      kind: 'profile',
      doctorProfileId: p.id,
      doctorName: p.fullName,
      name: p.fullName,
      requestedSpecialties: p.specialties.map((s) => ({
        id: s.specialty.id,
        name: s.specialty.name,
        slug: s.specialty.slug,
      })),
      createdAt: p.createdAt.toISOString(),
      ageSeconds,
      isDeactivated,
      deactivated: isDeactivated,
      _sortDate: p.createdAt,
    };
  });

  const mappedSpecialties: Array<VerificationQueueItem & { _sortDate: Date }> = specialties.map((s) => {
    const ageSeconds = Math.max(0, Math.floor((now - s.createdAt.getTime()) / 1000));
    const isDeactivated = Boolean(s.doctorProfile.user?.deactivatedAt);
    return {
      id: s.id,
      kind: 'specialty',
      doctorProfileId: s.doctorProfileId,
      doctorName: s.doctorProfile.fullName,
      name: s.doctorProfile.fullName,
      specialty: {
        id: s.specialty.id,
        name: s.specialty.name,
        slug: s.specialty.slug,
      },
      requestedSpecialties: s.doctorProfile.specialties.map((ds) => ({
        id: ds.specialty.id,
        name: ds.specialty.name,
        slug: ds.specialty.slug,
      })),
      createdAt: s.createdAt.toISOString(),
      ageSeconds,
      isDeactivated,
      deactivated: isDeactivated,
      _sortDate: s.createdAt,
    };
  });

  const merged = [...mappedProfiles, ...mappedSpecialties].sort((a, b) => {
    const timeDiff = a._sortDate.getTime() - b._sortDate.getTime();
    if (timeDiff !== 0) return timeDiff;
    return a.id.localeCompare(b.id);
  });

  const page = merged.slice(0, filters.limit);
  const hasMore = merged.length > filters.limit;
  const last = page[page.length - 1];

  return {
    items: page.map(({ _sortDate, ...item }) => item),
    nextCursor: hasMore && last ? encodeQueueCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function createSpecialty(
  actor: auditService.AuditActor,
  input: { name: string; slug?: string },
) {
  const name = input.name.trim();
  const slug = input.slug?.trim() || slugify(name);
  if (!slug) {
    throw new HttpError(400, 'Invalid specialty name or slug.');
  }

  const existing = await doctorsRepo.findSpecialtyByNameOrSlug(name, slug);
  if (existing) {
    throw new HttpError(409, 'Specialty with this name or slug already exists.');
  }

  return prisma.$transaction(async (tx) => {
    try {
      const specialty = await doctorsRepo.createSpecialty({ name, slug }, tx);
      await auditService.record(tx, actor, {
        entityType: 'Specialty',
        entityId: specialty.id,
        action: 'specialty.created',
        fromState: null,
        toState: 'active',
        metadata: { slug: specialty.slug },
      });
      return specialty;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new HttpError(409, 'Specialty with this name or slug already exists.');
      }
      throw err;
    }
  });
}

export async function updateSpecialty(
  actor: auditService.AuditActor,
  id: string,
  input: { name?: string; isRetired?: boolean },
) {
  return prisma.$transaction(async (tx) => {
    const specialty = await doctorsRepo.findSpecialtyById(id, tx);
    if (!specialty) {
      throw new HttpError(404, 'Specialty not found.');
    }

    const trimmedName = input.name?.trim();
    if (trimmedName && trimmedName !== specialty.name) {
      const duplicate = await doctorsRepo.findSpecialtyByName(trimmedName, id, tx);
      if (duplicate) {
        throw new HttpError(409, 'Specialty with this name already exists.');
      }
    }

    const willRename = Boolean(trimmedName && trimmedName !== specialty.name);
    const willRetire = Boolean(input.isRetired !== undefined && input.isRetired !== specialty.isRetired);

    if (!willRename && !willRetire) {
      return specialty;
    }

    const updated = await doctorsRepo.updateSpecialty(
      id,
      {
        ...(willRename ? { name: trimmedName } : {}),
        ...(input.isRetired !== undefined ? { isRetired: input.isRetired } : {}),
      },
      tx,
    );

    if (willRename) {
      await auditService.record(tx, actor, {
        entityType: 'Specialty',
        entityId: specialty.id,
        action: 'specialty.renamed',
        fromState: specialty.name,
        toState: trimmedName!,
        metadata: { slug: specialty.slug },
      });
    }

    if (willRetire) {
      await auditService.record(tx, actor, {
        entityType: 'Specialty',
        entityId: specialty.id,
        action: input.isRetired ? 'specialty.retired' : 'specialty.unretired',
        fromState: specialty.isRetired ? 'retired' : 'active',
        toState: input.isRetired ? 'retired' : 'active',
        metadata: { slug: specialty.slug },
      });
    }

    return updated;
  });
}

export async function retireSpecialty(actor: auditService.AuditActor, id: string) {
  return updateSpecialty(actor, id, { isRetired: true });
}

// --- Symptom -> specialty mapping (issue #60) ----------------------------
// Admin-managed controlled vocabulary. The mapping is reviewed guidance, not
// a diagnosis: nothing here scores a patient's symptoms, it only points from
// a plain-language complaint to specialties a doctor already lists.

export async function searchSymptoms(input: { q?: string; limit: number }) {
  const rows = await doctorsRepo.searchSymptoms(input.q ?? null, input.limit);
  return {
    items: rows.map((row) => ({ id: row.id, name: row.name, slug: row.slug })),
  };
}

export function listSymptomsForAdmin() {
  return doctorsRepo.findSymptomsForAdmin();
}

export async function createSymptom(actor: auditService.AuditActor, input: { name: string; slug?: string }) {
  const name = input.name.trim();
  const slug = input.slug?.trim() || slugify(name);
  if (!slug) {
    throw new HttpError(400, 'Invalid symptom name or slug.');
  }

  const existing = await doctorsRepo.findSymptomByNameOrSlug(name, slug);
  if (existing) {
    throw new HttpError(409, 'Symptom with this name or slug already exists.');
  }

  return prisma.$transaction(async (tx) => {
    try {
      const symptom = await doctorsRepo.createSymptom({ name, slug }, tx);
      await auditService.record(tx, actor, {
        entityType: 'Symptom',
        entityId: symptom.id,
        action: 'symptom.created',
        fromState: null,
        toState: 'active',
        metadata: { slug: symptom.slug },
      });
      return symptom;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new HttpError(409, 'Symptom with this name or slug already exists.');
      }
      throw err;
    }
  });
}

export async function updateSymptom(
  actor: auditService.AuditActor,
  id: string,
  input: { name?: string; isRetired?: boolean },
) {
  return prisma.$transaction(async (tx) => {
    const symptom = await doctorsRepo.findSymptomById(id, tx);
    if (!symptom) {
      throw new HttpError(404, 'Symptom not found.');
    }

    const trimmedName = input.name?.trim();
    if (trimmedName && trimmedName !== symptom.name) {
      const duplicate = await doctorsRepo.findSymptomByName(trimmedName, id, tx);
      if (duplicate) {
        throw new HttpError(409, 'Symptom with this name already exists.');
      }
    }

    const willRename = Boolean(trimmedName && trimmedName !== symptom.name);
    const willRetire = Boolean(input.isRetired !== undefined && input.isRetired !== symptom.isRetired);
    if (!willRename && !willRetire) {
      return symptom;
    }

    const updated = await doctorsRepo.updateSymptom(
      id,
      {
        ...(willRename ? { name: trimmedName } : {}),
        ...(input.isRetired !== undefined ? { isRetired: input.isRetired } : {}),
      },
      tx,
    );

    if (willRename) {
      await auditService.record(tx, actor, {
        entityType: 'Symptom',
        entityId: symptom.id,
        action: 'symptom.renamed',
        fromState: symptom.name,
        toState: trimmedName!,
        metadata: { slug: symptom.slug },
      });
    }
    if (willRetire) {
      await auditService.record(tx, actor, {
        entityType: 'Symptom',
        entityId: symptom.id,
        action: input.isRetired ? 'symptom.retired' : 'symptom.unretired',
        fromState: symptom.isRetired ? 'retired' : 'active',
        toState: input.isRetired ? 'retired' : 'active',
        metadata: { slug: symptom.slug },
      });
    }

    return updated;
  });
}

/** Replaces the whole mapping set for a symptom (PUT semantics): an omitted
 * specialty is unmapped, which is how "stop suggesting cardiology for
 * palpitations" is expressed. Duplicate specialty ids keep the highest
 * weight rather than failing. */
export async function setSymptomSpecialties(
  actor: auditService.AuditActor,
  id: string,
  requested: Array<{ specialtyId: string; weight: number }>,
) {
  const bySpecialty = new Map<string, number>();
  for (const mapping of requested) {
    bySpecialty.set(mapping.specialtyId, Math.max(bySpecialty.get(mapping.specialtyId) ?? 0, mapping.weight));
  }
  const mappings = [...bySpecialty.entries()].map(([specialtyId, weight]) => ({ specialtyId, weight }));

  return prisma.$transaction(async (tx) => {
    const symptom = await doctorsRepo.findSymptomById(id, tx);
    if (!symptom) {
      throw new HttpError(404, 'Symptom not found.');
    }
    if (mappings.length > 0) {
      const specialties = await doctorsRepo.findSpecialtiesByIds(
        mappings.map((mapping) => mapping.specialtyId),
        tx,
      );
      if (specialties.length !== mappings.length) {
        throw new HttpError(400, 'One or more specialty ids are unknown.');
      }
    }

    await doctorsRepo.replaceSymptomSpecialties(id, mappings, tx);
    await auditService.record(tx, actor, {
      entityType: 'Symptom',
      entityId: symptom.id,
      action: 'symptom.mappings_replaced',
      fromState: null,
      toState: `${mappings.length} mapping(s)`,
      metadata: {
        slug: symptom.slug,
        // Audit metadata values are scalars; the mapping set is summarised
        // rather than nested (the row-level change is reconstructable from
        // SymptomSpecialty's own createdAt/audit trail).
        mappings: mappings.map((mapping) => `${mapping.specialtyId}:${mapping.weight}`).join(','),
      },
    });
    return doctorsRepo
      .findSymptomsForAdmin(tx)
      .then((all: Awaited<ReturnType<typeof doctorsRepo.findSymptomsForAdmin>>) =>
        all.find((row) => row.id === symptom.id) ?? null,
      );
  });
}
