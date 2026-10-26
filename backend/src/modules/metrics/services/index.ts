import { prisma } from '../../../db/prisma-client';

const MIN_CELL_COUNT = 5;

export type MetricAggregate = {
  eligibleCount: bigint;
  noShowCount: bigint;
  averageLeadSeconds: number | null;
  leadTimeCount: bigint;
};

export async function getSuccessMetrics(from: Date, to: Date) {
  const [aggregate] = await prisma.$queryRaw<MetricAggregate[]>`
    SELECT
      COUNT(*) FILTER (WHERE "status" IN ('completed', 'no_show')) AS "eligibleCount",
      COUNT(*) FILTER (WHERE "status" = 'no_show') AS "noShowCount",
      (AVG(EXTRACT(EPOCH FROM ("appointmentAt" - "bookedAt")))
        FILTER (WHERE "status" IN ('completed', 'no_show')))::double precision AS "averageLeadSeconds",
      COUNT(*) FILTER (WHERE "status" IN ('completed', 'no_show')) AS "leadTimeCount"
    FROM "SuccessMetricAppointment"
    WHERE "appointmentAt" >= ${from} AND "appointmentAt" < ${to}
  `;

  return formatMetrics(aggregate, from, to);
}

export function formatMetrics(aggregate: MetricAggregate, from: Date, to: Date) {
  const n = Number(aggregate.eligibleCount);
  const suppressed = n < MIN_CELL_COUNT;
  return {
    window: { from: from.toISOString(), to: to.toISOString(), timeZone: 'UTC' },
    minimumCellCount: MIN_CELL_COUNT,
    metrics: {
      noShowRate: {
        status: suppressed ? 'suppressed' : 'available',
        value: suppressed ? null : Number(aggregate.noShowCount) / n,
        numerator: suppressed ? null : Number(aggregate.noShowCount),
        denominator: suppressed ? null : n,
      },
      bookingLeadTimeDays: {
        status: Number(aggregate.leadTimeCount) < MIN_CELL_COUNT ? 'suppressed' : 'available',
        value: Number(aggregate.leadTimeCount) < MIN_CELL_COUNT || aggregate.averageLeadSeconds === null
          ? null
          : aggregate.averageLeadSeconds / 86_400,
        unit: 'days',
        denominator: Number(aggregate.leadTimeCount) < MIN_CELL_COUNT ? null : Number(aggregate.leadTimeCount),
      },
      timeFromSymptomToOrder: { status: 'not_yet_available', value: null },
      referralCompletionRate: { status: 'not_yet_available', value: null },
      ordersFulfilledWithinNDays: { status: 'not_yet_available', value: null },
    },
  };
}
