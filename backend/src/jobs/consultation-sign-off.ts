// Consultation auto sign-off sweep (Phase 2, issue #64). Notes stay editable
// for a configurable grace period after the consultation is closed; this
// sweep signs the ones nobody has signed manually. One conditional UPDATE
// (`WHERE signedAt IS NULL AND createdAt < cutoff`), so it is safe to run in
// more than one process and cannot re-sign or alter a signed note.
// Started from src/server.ts only.
import { config } from '../config';
import { autoSignOffOverdue } from '../modules/consultations/services';
import { logger } from '../logger';

export function startConsultationSignOffJob(): () => void {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void autoSignOffOverdue()
      .then(({ signed }) => {
        if (signed > 0) {
          // Count only — never ids or notes.
          logger.info(`[jobs] consultation sign-off: ${signed} signed`);
        }
      })
      .catch((err) => {
        logger.error(`[jobs] consultation sign-off failed: ${err instanceof Error ? err.name : typeof err}`);
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  const timer = setInterval(run, config.consultations.signOffSweepIntervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
