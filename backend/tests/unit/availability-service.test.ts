import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  listOpenSlots,
  generateSlots,
  isOverlapOrUniqueViolation,
} from '../../src/modules/availability/services';
import * as availabilityRepo from '../../src/modules/availability/repositories';
import * as doctorsService from '../../src/modules/doctors/services';
import { HttpError } from '../../src/http-error';

vi.mock('../../src/modules/availability/repositories', () => ({
  findExistingSlotRanges: vi.fn(),
  createSlots: vi.fn(),
  findOpenSlots: vi.fn(),
}));

vi.mock('../../src/modules/doctors/services', () => ({
  getDoctorProfileById: vi.fn(),
  isDoctorVerified: vi.fn(),
}));

describe('availability service unit tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isOverlapOrUniqueViolation', () => {
    it('handles falsy or non-object errors', () => {
      expect(isOverlapOrUniqueViolation(null)).toBe(false);
      expect(isOverlapOrUniqueViolation(undefined)).toBe(false);
      expect(isOverlapOrUniqueViolation('some string')).toBe(false);
      expect(isOverlapOrUniqueViolation(123)).toBe(false);
    });

    it('identifies Prisma P2002 error', () => {
      expect(isOverlapOrUniqueViolation({ code: 'P2002' })).toBe(true);
    });

    it('identifies postgres exclusion violation messages', () => {
      expect(isOverlapOrUniqueViolation({ message: 'violates exclusion constraint "AvailabilitySlot_doctor_no_overlap_excl"' })).toBe(true);
      expect(isOverlapOrUniqueViolation({ message: 'PostgreSQL error code 23P01' })).toBe(true);
      expect(isOverlapOrUniqueViolation({ message: 'exclusion constraint violation' })).toBe(true);
    });

    it('returns false for unrelated errors', () => {
      expect(isOverlapOrUniqueViolation({ code: 'P2003', message: 'foreign key constraint' })).toBe(false);
      expect(isOverlapOrUniqueViolation(new Error('Connection lost'))).toBe(false);
    });
  });

  describe('listOpenSlots', () => {
    const fixedNow = new Date('2026-11-20T12:00:00.000Z');

    it('returns empty array when doctor profile is not found (404)', async () => {
      vi.mocked(doctorsService.getDoctorProfileById).mockRejectedValueOnce(new HttpError(404, 'Doctor not found'));
      const slots = await listOpenSlots('non-existent-id', undefined, fixedNow);
      expect(slots).toEqual([]);
    });

    it('re-throws non-404 error from getDoctorProfileById', async () => {
      vi.mocked(doctorsService.getDoctorProfileById).mockRejectedValueOnce(new HttpError(500, 'Database error'));
      await expect(listOpenSlots('doc-1', undefined, fixedNow)).rejects.toThrow('Database error');
    });

    it('throws 409 if doctor is deactivated', async () => {
      vi.mocked(doctorsService.getDoctorProfileById).mockResolvedValueOnce({
        id: 'doc-1',
        user: { deactivatedAt: new Date(), deletedAt: null },
      } as any);
      await expect(listOpenSlots('doc-1', undefined, fixedNow)).rejects.toThrowError(
        expect.objectContaining({ status: 409, message: 'Doctor is not available for booking.' }),
      );
    });

    it('throws 409 if doctor is deleted', async () => {
      vi.mocked(doctorsService.getDoctorProfileById).mockResolvedValueOnce({
        id: 'doc-1',
        user: { deactivatedAt: null, deletedAt: new Date() },
      } as any);
      await expect(listOpenSlots('doc-1', undefined, fixedNow)).rejects.toThrowError(
        expect.objectContaining({ status: 409, message: 'Doctor is not available for booking.' }),
      );
    });

    it('clamps from date in the past to now', async () => {
      vi.mocked(doctorsService.getDoctorProfileById).mockResolvedValueOnce({
        id: 'doc-1',
        user: { deactivatedAt: null, deletedAt: null },
      } as any);
      vi.mocked(doctorsService.isDoctorVerified).mockResolvedValueOnce(true);
      vi.mocked(availabilityRepo.findOpenSlots).mockResolvedValueOnce([]);

      await listOpenSlots('doc-1', { from: '2026-11-01T00:00:00.000Z' }, fixedNow);
      expect(availabilityRepo.findOpenSlots).toHaveBeenCalledWith(
        'doc-1',
        fixedNow,
        expect.any(Date),
      );
    });

    it('rejects from date after to date with 400', async () => {
      vi.mocked(doctorsService.getDoctorProfileById).mockResolvedValueOnce({
        id: 'doc-1',
        user: { deactivatedAt: null, deletedAt: null },
      } as any);

      await expect(
        listOpenSlots('doc-1', { from: '2026-11-25T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' }, fixedNow),
      ).rejects.toThrowError(expect.objectContaining({ status: 400, code: 'INVALID_DATE_RANGE' }));
    });

    it('rejects date range exceeding maximum with 400', async () => {
      vi.mocked(doctorsService.getDoctorProfileById).mockResolvedValueOnce({
        id: 'doc-1',
        user: { deactivatedAt: null, deletedAt: null },
      } as any);

      await expect(
        listOpenSlots('doc-1', { from: '2026-11-20T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' }, fixedNow),
      ).rejects.toThrowError(expect.objectContaining({ status: 400, code: 'DATE_RANGE_TOO_LARGE' }));
    });

    it('returns empty array when doctor is not verified', async () => {
      vi.mocked(doctorsService.getDoctorProfileById).mockResolvedValueOnce({
        id: 'doc-1',
        user: { deactivatedAt: null, deletedAt: null },
      } as any);
      vi.mocked(doctorsService.isDoctorVerified).mockResolvedValueOnce(false);

      const slots = await listOpenSlots('doc-1', undefined, fixedNow);
      expect(slots).toEqual([]);
      expect(availabilityRepo.findOpenSlots).not.toHaveBeenCalled();
    });

    it('returns open slots when doctor is verified', async () => {
      vi.mocked(doctorsService.getDoctorProfileById).mockResolvedValueOnce({
        id: 'doc-1',
        user: { deactivatedAt: null, deletedAt: null },
      } as any);
      vi.mocked(doctorsService.isDoctorVerified).mockResolvedValueOnce(true);
      const mockSlots = [{ id: 'slot-1' }] as any;
      vi.mocked(availabilityRepo.findOpenSlots).mockResolvedValueOnce(mockSlots);

      const slots = await listOpenSlots('doc-1', undefined, fixedNow);
      expect(slots).toBe(mockSlots);
    });
  });

  describe('generateSlots', () => {
    it('returns 0 created when all proposed slots are skipped in past', async () => {
      const result = await generateSlots({
        doctorProfileId: 'doc-1',
        date: new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date()),
        startHour: 0,
        endHour: 1,
        slotLengthMinutes: 30,
        timeZone: 'UTC',
      });
      // StartHour 0 to 1 today is in the past
      expect(result).toEqual({ created: 0, skippedOverlapping: 0, skipped: 0 });
    });

    it('returns skipped count when all proposed slots overlap existing slots', async () => {
      vi.mocked(availabilityRepo.findExistingSlotRanges).mockResolvedValueOnce([
        {
          startTime: new Date('2026-12-01T09:00:00.000Z'),
          endTime: new Date('2026-12-01T11:00:00.000Z'),
        },
      ]);

      const result = await generateSlots({
        doctorProfileId: 'doc-1',
        date: '2026-12-01',
        startHour: 9,
        endHour: 11,
        slotLengthMinutes: 60,
        timeZone: 'UTC',
      });
      expect(result).toEqual({ created: 0, skippedOverlapping: 2, skipped: 2 });
    });

    it('creates slots and returns created and skipped counts', async () => {
      vi.mocked(availabilityRepo.findExistingSlotRanges).mockResolvedValueOnce([
        {
          startTime: new Date('2026-12-01T09:00:00.000Z'),
          endTime: new Date('2026-12-01T10:00:00.000Z'),
        },
      ]);
      vi.mocked(availabilityRepo.createSlots).mockResolvedValueOnce({ count: 1 });

      const result = await generateSlots({
        doctorProfileId: 'doc-1',
        date: '2026-12-01',
        startHour: 9,
        endHour: 11,
        slotLengthMinutes: 60,
        timeZone: 'UTC',
      });
      expect(result).toEqual({ created: 1, skippedOverlapping: 1, skipped: 1 });
    });

    it('throws 409 when createSlots fails with unique or exclusion constraint error', async () => {
      vi.mocked(availabilityRepo.findExistingSlotRanges).mockResolvedValueOnce([]);
      vi.mocked(availabilityRepo.createSlots).mockRejectedValueOnce({
        code: 'P2002',
        message: 'Unique constraint failed',
      });

      await expect(
        generateSlots({
          doctorProfileId: 'doc-1',
          date: '2026-12-01',
          startHour: 9,
          endHour: 11,
          slotLengthMinutes: 60,
          timeZone: 'UTC',
        }),
      ).rejects.toThrowError(expect.objectContaining({ status: 409, message: 'Slot overlaps with an existing slot.' }));
    });

    it('throws 409 when createSlots fails with exclusion constraint error message', async () => {
      vi.mocked(availabilityRepo.findExistingSlotRanges).mockResolvedValueOnce([]);
      vi.mocked(availabilityRepo.createSlots).mockRejectedValueOnce({
        message: 'violates exclusion constraint "AvailabilitySlot_doctor_no_overlap_excl"',
      });

      await expect(
        generateSlots({
          doctorProfileId: 'doc-1',
          date: '2026-12-01',
          startHour: 9,
          endHour: 11,
          slotLengthMinutes: 60,
          timeZone: 'UTC',
        }),
      ).rejects.toThrowError(expect.objectContaining({ status: 409, message: 'Slot overlaps with an existing slot.' }));
    });

    it('re-throws unexpected error from createSlots', async () => {
      vi.mocked(availabilityRepo.findExistingSlotRanges).mockResolvedValueOnce([]);
      vi.mocked(availabilityRepo.createSlots).mockRejectedValueOnce(new Error('Connection failure'));

      await expect(
        generateSlots({
          doctorProfileId: 'doc-1',
          date: '2026-12-01',
          startHour: 9,
          endHour: 11,
          slotLengthMinutes: 60,
          timeZone: 'UTC',
        }),
      ).rejects.toThrow('Connection failure');
    });

    it('throws 400 when slot-generation input fails pure buildSlotRanges check', async () => {
      await expect(
        generateSlots({
          doctorProfileId: 'doc-1',
          date: '2026-12-01',
          startHour: 18,
          endHour: 9,
          slotLengthMinutes: 30,
          timeZone: 'UTC',
        }),
      ).rejects.toThrowError(expect.objectContaining({ status: 400 }));
    });
  });
});
