// Abnormal lab result escalation (Phase 4, issue #72, PRD §8.2.7).
//
// Runs the module's escalation sweep on an interval. This job is only a
// scheduler: the transition is a conditional UPDATE in
// modules/orders/services/lab-result-acknowledgements.ts, so overlapping runs
// and multiple processes are safe, and a doctor's acknowledgement that wins
// the race is never escalated afterwards.
//
// "A missed tick must not skip escalation" is handled in two places:
//  - the sweep runs once at startup and drains its backlog in bounded pages;
//  - the admin queue derives `overdue` from `escalationDueAt <= now`, so an
//    overdue result is visible even before this job has stamped it.
import { config } from '../config';
import { escalateOverdueResults } from '../modules/orders/services/lab-result-acknowledgements';

export function startLabResultEscalationJobs(): () => void {
  let running = false;

  const sweep = () => {
    if (running) return;
    running = true;
    void escalateOverdueResults()
      .then(({ escalated }) => {
        if (escalated > 0) {
          // eslint-disable-next-line no-console
          console.log(`[jobs] escalated ${escalated} unacknowledged lab result(s)`);
        }
      })
      .catch((err) => {
        // Error type only: a driver message can echo the row it was handling.
        // eslint-disable-next-line no-console
        console.error(
          `[jobs] lab-result escalation sweep failed: ${err instanceof Error ? err.name : typeof err}`,
        );
      })
      .finally(() => {
        running = false;
      });
  };

  const timer = setInterval(sweep, config.labResults.escalationSweepSeconds * 1000);
  timer.unref();
  // Catch up anything already overdue on startup.
  sweep();

  return () => clearInterval(timer);
}
