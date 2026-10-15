import { createApp } from './app';
import { config } from './config';
import { pruneLoginAttempts } from './modules/auth/services';

const app = createApp();

// Background jobs are started here rather than in app.ts, so importing the
// app (every integration test does) never starts a timer.
startConsultationAutoSignOffJob();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`docforum-core backend listening on :${config.port}`);
});

// Login-throttle cleanup (Phase 8, issue #35). A plain interval, per
// ARCHITECTURE_ESSENTIALS.md ("keep jobs simple until a real job exists —
// don't pre-install a queue"); `unref()` so it never keeps the process
// alive on shutdown. Lives here rather than in app.ts so test suites, which
// only build the app, don't start a timer.
const pruneTimer = setInterval(() => {
  void pruneLoginAttempts()
    .then((removed) => {
      if (removed > 0) {
        // eslint-disable-next-line no-console
        console.log(`[jobs] pruned ${removed} stale login-throttle row(s)`);
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[jobs] login-throttle prune failed:', err);
    });
}, config.loginThrottle.pruneIntervalSeconds * 1000);
pruneTimer.unref();
