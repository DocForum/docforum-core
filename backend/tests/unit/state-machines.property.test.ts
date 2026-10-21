import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AppointmentStatus, PaymentIntentStatus } from '@prisma/client';
import { transitionAppointmentStatus } from '../../src/modules/appointments/state-machine';
import { transitionPaymentIntentStatus } from '../../src/modules/payments/services/state-machine';

const seed = Number(process.env.PROPERTY_TEST_SEED ?? 424242);
const numRuns = Number(process.env.PROPERTY_TEST_RUNS ?? 300);

describe('lifecycle state-machine properties', () => {
  it('never moves an appointment out of its terminal state', () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom<AppointmentStatus>('scheduled', 'completed', 'cancelled', 'no_show'), { maxLength: 100 }),
      (operations) => {
        let state: AppointmentStatus = 'scheduled';
        for (const requested of operations) {
          const next = transitionAppointmentStatus(state, requested);
          if (next !== null) state = next;
          expect(['scheduled', 'completed', 'cancelled', 'no_show']).toContain(state);
          if (state !== 'scheduled') {
            expect(transitionAppointmentStatus(state, 'scheduled')).toBeNull();
            expect(transitionAppointmentStatus(state, 'completed')).toBeNull();
            expect(transitionAppointmentStatus(state, 'cancelled')).toBeNull();
            expect(transitionAppointmentStatus(state, 'no_show')).toBeNull();
          }
        }
      },
    ), { seed, numRuns });
  });

  it('keeps payment intents in the created → escrowed → released/refunded lifecycle', () => {
    fc.assert(fc.property(
      fc.array(fc.constantFrom<PaymentIntentStatus>('created', 'escrowed', 'released', 'refunded', 'failed'), { maxLength: 100 }),
      (operations) => {
        let state: PaymentIntentStatus = 'created';
        for (const requested of operations) {
          const next = transitionPaymentIntentStatus(state, requested);
          if (next !== null) state = next;
          expect(['created', 'escrowed', 'released', 'refunded', 'failed']).toContain(state);
          if (state === 'released' || state === 'refunded' || state === 'failed') {
            for (const later of ['created', 'escrowed', 'released', 'refunded', 'failed'] as const) {
              expect(transitionPaymentIntentStatus(state, later)).toBeNull();
            }
          }
        }
      },
    ), { seed: seed + 2, numRuns });
  });
});
