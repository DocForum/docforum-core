// Batch bounds for the order-expiry sweeps (issue #348). Both sweeps select
// at most `batchSize` ids at a time and process at most `maxPerRun` ids per
// tick; rows left over are picked up by the next scheduled run.
const batchSize = Number(process.env.EXPIRY_SWEEP_BATCH_SIZE ?? 100);
const configuredCap = Number(process.env.EXPIRY_SWEEP_MAX_PER_RUN ?? 1000);

function positiveInt(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const effectiveBatchSize = positiveInt(batchSize, 100);
const effectiveCap = positiveInt(configuredCap, 1000);

export const expirySweeps = {
  batchSize: effectiveBatchSize,
  // Documented behavior: a cap below one batch is raised to the batch size,
  // so a tick never does less than one bounded batch before yielding.
  maxPerRun: Math.max(effectiveCap, effectiveBatchSize),
} as const;
