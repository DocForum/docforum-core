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

  it('skips proposed slots that overlap existing slots when mixing slot lengths (issue #287)', () => {
    // Generate 30-min slots: 09:00-09:30, 09:30-10:00
    const existing30 = buildSlotRanges({
      doctorProfileId: 'doctor-mix-fixture',
      date: '2026-10-22',
      startHour: 9,
      endHour: 10,
      slotLengthMinutes: 30,
    });
    expect(existing30).toHaveLength(2);

    // Now generate 20-min slots over the same morning (09:00-10:00)
    // 09:00-09:20 overlaps 09:00-09:30
    // 09:20-09:40 overlaps 09:00-09:30 and 09:30-10:00
    // 09:40-10:00 overlaps 09:30-10:00
    // All 3 candidate slots must be skipped
    const proposed20 = buildSlotRanges({
      doctorProfileId: 'doctor-mix-fixture',
      date: '2026-10-22',
      startHour: 9,
      endHour: 10,
      slotLengthMinutes: 20,
    }, existing30);
    expect(proposed20).toEqual([]);

    // Generate 20-min slots for a wider window (08:00-10:00)
    // 08:00-08:20, 08:20-08:40, 08:40-09:00 are before 09:00 and should be generated!
    const wider20 = buildSlotRanges({
      doctorProfileId: 'doctor-mix-fixture',
      date: '2026-10-22',
      startHour: 8,
      endHour: 10,
      slotLengthMinutes: 20,
    }, existing30);
    expect(wider20).toHaveLength(3);
    expect(wider20[0].startTime.toISOString()).toContain('08:00');
    expect(wider20[1].startTime.toISOString()).toContain('08:20');
    expect(wider20[2].startTime.toISOString()).toContain('08:40');
    expect(wider20[2].endTime.toISOString()).toContain('09:00');
  });

  it('property: no generated slot ever overlaps any existing slot range (issue #287)', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 120 }),
      fc.integer({ min: 1, max: 120 }),
      (len1, len2) => {
        const existing = buildSlotRanges({
          doctorProfileId: 'doctor-property-fixture',
          date: '2026-10-22',
          startHour: 9,
          endHour: 17,
          slotLengthMinutes: len1,
        });

        const generated = buildSlotRanges({
          doctorProfileId: 'doctor-property-fixture',
          date: '2026-10-22',
          startHour: 8,
          endHour: 18,
          slotLengthMinutes: len2,
        }, existing);

        // Verify none of the generated slots overlap any existing slot
        for (const gen of generated) {
          const genStart = gen.startTime.getTime();
          const genEnd = gen.endTime.getTime();
          for (const ex of existing) {
            const exStart = ex.startTime.getTime();
            const exEnd = ex.endTime.getTime();
            if (genStart < exEnd && genEnd > exStart) {
              throw new Error(`Generated slot [${gen.startTime.toISOString()}, ${gen.endTime.toISOString()}) overlaps existing [${ex.startTime.toISOString()}, ${ex.endTime.toISOString()})`);
            }
          }
        }
      },
    ), { seed: seed + 2, numRuns: 100 });
  });
});
