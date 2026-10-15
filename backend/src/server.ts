import { createApp } from './app';
import { config } from './config';
import { startConsultationAutoSignOffJob } from './jobs/consultation-auto-sign-off';

const app = createApp();

// Background jobs are started here rather than in app.ts, so importing the
// app (every integration test does) never starts a timer.
startConsultationAutoSignOffJob();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`docforum-core backend listening on :${config.port}`);
});
