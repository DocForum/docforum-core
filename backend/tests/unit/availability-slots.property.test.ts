import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildSlotRanges } from '../../src/modules/availability/slot-generation';

const seed = Number(process.env.PROPERTY_TEST_SEED ?? 424242);
const numRuns = Number(process.env.PROPERTY_TEST_RUNS ?? 300);

describe('slot generation properties', () => {
  it('keeps generated slots in range, non-overlapping, and exactly the requested duration', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 23 }),
      fc.integer({ min: 1, max: 8 }),
      fc.integer({ min: 1, max: 120 }),
      (startHour, span, slotLengthMinutes) => {
        const endHour = Math.min(24, startHour + span);
        const input = {
          doctorProfileId: 'doctor-property-fixture',
          date: '2026-10-22',
          startHour,
          endHour,
          slotLengthMinutes,
        };
        const slots = buildSlotRanges(input);
        const lower = Date.parse(`${input.date}T00:00:00.000Z`) + startHour * 60 * 60_000;
        const upper = Date.parse(`${input.date}T00:00:00.000Z`) + endHour * 60 * 60_000;
        const duration = slotLengthMinutes * 60_000;

        for (const slot of slots) {
          if (slot.startTime.getTime() < lower || slot.endTime.getTime() > upper) {
            throw new Error('Generated slot falls outside the requested window.');
          }
          if (slot.endTime.getTime() - slot.startTime.getTime() !== duration) {
            throw new Error('Generated slot duration differs from the requested duration.');
          }
        }
        for (let index = 1; index < slots.length; index += 1) {
          if (slots[index - 1].endTime.getTime() > slots[index].startTime.getTime()) {
            throw new Error('Generated slots overlap.');
          }
        }
      },
    ), { seed, numRuns });
  });

  it('is idempotent when generated slot starts already exist', () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 23 }),
      fc.integer({ min: 1, max: 8 }),
      fc.integer({ min: 1, max: 180 }),
      (startHour, span, slotLengthMinutes) => {
        const input = {
          doctorProfileId: 'doctor-property-fixture',
          date: '2026-10-22',
          startHour,
          endHour: Math.min(24, startHour + span),
          slotLengthMinutes,
        };
        const first = buildSlotRanges(input);
        const second = buildSlotRanges(input, first.map((slot) => slot.startTime.getTime()));
        expect(second).toEqual([]);
      },
    ), { seed: seed + 1, numRuns });
  });

  it('rejects calendar dates that JavaScript would otherwise normalize', () => {
    expect(() => buildSlotRanges({
      doctorProfileId: 'doctor-property-fixture',
      date: '2026-02-30',
      startHour: 9,
      endHour: 10,
      slotLengthMinutes: 30,
    })).toThrow('date must be a valid ISO date.');
  });
});
