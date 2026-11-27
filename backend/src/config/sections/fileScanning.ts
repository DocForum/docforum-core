// failOpen is a getter so tests can change FILE_SCANNING_FAIL_OPEN after
// the module loads (the other fields are start-up settings that do not
// need to change at runtime).
export const fileScanning = {
  clamavEnabled: process.env.FILE_SCANNING_CLAMAV_ENABLED === 'true',
  clamavHost: process.env.FILE_SCANNING_CLAMAV_HOST ?? '127.0.0.1',
  clamavPort: parseInt(process.env.FILE_SCANNING_CLAMAV_PORT ?? '3310', 10),
  // fail-open: when true (the default), a scanner error allows the upload
  // to proceed and is logged. When false (production hardening), a scanner
  // error blocks the upload with 503. Set FILE_SCANNING_FAIL_OPEN=false to
  // fail-closed (docs/adr/0014). Re-read on every access so integration
  // tests can toggle it without reimporting the module.
  get failOpen(): boolean {
    return process.env.FILE_SCANNING_FAIL_OPEN !== 'false';
  },
};
