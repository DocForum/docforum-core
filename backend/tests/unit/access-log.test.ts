// Unit tests for the PHI read-access logging service (Phase 8, issue #45).
// Tests the async fire-and-forget write path, fail-open behavior, the
// failure counter for alerting, and the patient-facing PII stripping.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the repository before importing the service
vi.mock('../../src/modules/audit/repositories', () => ({
  recordAccess: vi.fn().mockResolvedValue({}),
  findAccessByEntity: vi.fn().mockResolvedValue([]),
  findAccessForPatient: vi.fn().mockResolvedValue([]),
  findAccessByUser: vi.fn().mockResolvedValue([]),
  pruneAccessLogs: vi.fn().mockResolvedValue(0),
}));

import * as auditService from '../../src/modules/audit/services';
import * as auditRepo from '../../src/modules/audit/repositories';

/** Waits for fire-and-forget promises to settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('access-log service: PHI read-access logging (issue #45)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('recordAccess (async, fire-and-forget)', () => {
    it('returns immediately without awaiting the insert (off the read path)', () => {
      // Make the repo insert hang to prove recordAccess doesn't block on it.
      vi.mocked(auditRepo.recordAccess).mockReturnValue(new Promise(() => {}) as never);

      const start = performance.now();
      auditService.recordAccess({
        accessedBy: 'user-123',
        entityType: 'Consultation',
        entityId: 'consult-456',
        route: '/appointments/mine',
      });
      const elapsed = performance.now() - start;

      // Fire-and-forget: must return in well under 1ms (no DB round-trip).
      expect(elapsed).toBeLessThan(50);
    });

    it('passes all fields through to the repository', async () => {
      auditService.recordAccess({
        accessedBy: 'user-123',
        patientProfileId: 'profile-789',
        entityType: 'Consultation',
        entityId: 'consult-456',
        route: '/appointments/mine',
        detail: 'GET /appointments/mine',
      });
      await flush();

      expect(auditRepo.recordAccess).toHaveBeenCalledWith({
        accessedBy: 'user-123',
        patientProfileId: 'profile-789',
        entityType: 'Consultation',
        entityId: 'consult-456',
        route: '/appointments/mine',
        detail: 'GET /appointments/mine',
      });
    });

    it('defaults optional fields to null', async () => {
      auditService.recordAccess({
        entityType: 'IntakeForm',
        entityId: 'intake-000',
      });
      await flush();

      expect(auditRepo.recordAccess).toHaveBeenCalledWith({
        accessedBy: null,
        patientProfileId: null,
        entityType: 'IntakeForm',
        entityId: 'intake-000',
        route: null,
        detail: null,
      });
    });

    it('fails open: does not throw when the repository write rejects', async () => {
      vi.mocked(auditRepo.recordAccess).mockRejectedValueOnce(new Error('DB down'));

      expect(() =>
        auditService.recordAccess({
          accessedBy: 'user-123',
          entityType: 'Prescription',
          entityId: 'presc-001',
        }),
      ).not.toThrow();

      await flush();

      // The failure was surfaced to the server console for operators
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('[audit] FAILED to record access'),
        expect.any(Error),
      );
    });

    it('increments the failure counter on each logging failure (alerting)', async () => {
      const before = auditService.getLogFailureCount();

      vi.mocked(auditRepo.recordAccess).mockRejectedValueOnce(new Error('fail 1'));
      auditService.recordAccess({ entityType: 'LabOrder', entityId: 'lab-1' });
      await flush();

      vi.mocked(auditRepo.recordAccess).mockRejectedValueOnce(new Error('fail 2'));
      auditService.recordAccess({ entityType: 'LabOrder', entityId: 'lab-2' });
      await flush();

      expect(auditService.getLogFailureCount()).toBe(before + 2);
    });

    it('accepts all AccessEntityType variants', async () => {
      const types = [
        'IntakeForm',
        'Consultation',
        'Prescription',
        'PrescriptionItem',
        'LabOrder',
        'LabResult',
        'Referral',
        'PaymentIntent',
        'PatientProfile',
        'Appointment',
      ] as const;

      for (const entityType of types) {
        auditService.recordAccess({ entityType, entityId: 'x' });
      }
      await flush();

      expect(auditRepo.recordAccess).toHaveBeenCalledTimes(types.length);
    });
  });

  describe('getAccessForPatient (patient-facing, PII stripped)', () => {
    it('returns only role, entity, and timestamp — no viewer email or ids', async () => {
      vi.mocked(auditRepo.findAccessForPatient).mockResolvedValueOnce([
        {
          id: 'log-1',
          accessedAt: new Date('2026-10-16T10:00:00Z'),
          entityType: 'Consultation',
          entityId: 'consult-1',
          accessedBy: 'doctor-user-id',
          accessedByUser: { id: 'doctor-user-id', role: 'doctor' },
        },
        {
          id: 'log-2',
          accessedAt: new Date('2026-10-16T11:00:00Z'),
          entityType: 'IntakeForm',
          entityId: 'intake-1',
          accessedBy: null,
          accessedByUser: null,
        },
      ] as never);

      const logs = await auditService.getAccessForPatient('profile-1');

      expect(logs).toHaveLength(2);
      // Patient-facing shape: only these keys — no email, no viewer internal id
      for (const log of logs) {
        expect(Object.keys(log).sort()).toEqual(
          ['accessedAt', 'entityId', 'entityType', 'id', 'viewerRole'].sort(),
        );
        expect(log).not.toHaveProperty('accessedBy');
        expect(log).not.toHaveProperty('email');
      }
      expect(logs[0]!.viewerRole).toBe('doctor');
      // Deleted user (SetNull) surfaces as a placeholder, not an error
      expect(logs[1]!.viewerRole).toBe('deleted_user');
    });
  });

  describe('pruneOldAccessLogs (retention)', () => {
    it('deletes rows older than the retention window', async () => {
      vi.mocked(auditRepo.pruneAccessLogs).mockResolvedValueOnce(42);

      const deleted = await auditService.pruneOldAccessLogs();

      expect(auditRepo.pruneAccessLogs).toHaveBeenCalledWith(expect.any(Date));
      expect(deleted).toBe(42);

      // The cutoff should be ~retention-days in the past
      const cutoff = vi.mocked(auditRepo.pruneAccessLogs).mock.calls[0]![0] as Date;
      const daysOld = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
      expect(daysOld).toBeCloseTo(auditService.ACCESS_LOG_RETENTION_DAYS, 0);
    });
  });
});
