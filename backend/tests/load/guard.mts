// Refuse to point load-test tooling at a shared environment (issue #349:
// never run against the shared Render preview).
export function refuseSharedTargets(...urls: (string | undefined)[]): void {
  for (const url of urls) {
    if (!url) continue;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (host.endsWith('onrender.com') || host.endsWith('render.com')) {
      console.error(`Refusing to run load-test tooling against a Render host (${host}).`);
      process.exit(2);
    }
  }
}
