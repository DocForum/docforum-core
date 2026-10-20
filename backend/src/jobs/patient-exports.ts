// Patient data export jobs (Phase 8, issue #40). Plain intervals, per
// ARCHITECTURE_ESSENTIALS.md ("keep jobs simple until a real job exists —
// don't pre-install a queue"). Started from src/server.ts only, so test
// suites that just build the app never start a timer; tests drive the
// service functions directly.
//
// Safe with more than one process: every state change underneath is a
// conditional UPDATE in the patients module, so two workers racing for the
// same job end with exactly one generating it.
import { config } from '../config';
import { expireExports, onExportRequested, runExportWorker } from '../modules/patients/services';

/** Runs `task` unless a previous run is still going (no overlap within one
 * process — generation is sequential by design). */
function nonOverlapping(name: string, task: () => Promise<unknown>) {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    void task()
      .catch((err) => {
        // Error type only: a database error message can echo row data.
        // eslint-disable-next-line no-console
        console.error(`[jobs] ${name} failed: ${err instanceof Error ? err.name : typeof err}`);
      })
      .finally(() => {
        running = false;
      });
  };
}

export function startPatientExportJobs(): () => void {
  const work = nonOverlapping('patient-export worker', () => runExportWorker());
  const cleanup = nonOverlapping('patient-export cleanup', async () => {
    const { expired, orphanChunksDeleted } = await expireExports();
    if (expired > 0 || orphanChunksDeleted > 0) {
      // eslint-disable-next-line no-console
      console.log(`[jobs] expired ${expired} patient export(s), removed ${orphanChunksDeleted} orphan chunk(s)`);
    }
  });

  onExportRequested(work);
  const workTimer = setInterval(work, config.patientExport.workerIntervalSeconds * 1000);
  const cleanupTimer = setInterval(cleanup, config.patientExport.cleanupIntervalSeconds * 1000);
  workTimer.unref();
  cleanupTimer.unref();
  // Pick up anything left pending by a previous process.
  work();

  return () => {
    onExportRequested(null);
    clearInterval(workTimer);
    clearInterval(cleanupTimer);
  };
}
