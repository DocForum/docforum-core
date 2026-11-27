// Refuse to point load-test tooling at a shared environment (issue #349:
// never run against the shared Render preview).
/** True for render.com / onrender.com and any of their subdomains. */
export function isRenderHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return ['render.com', 'onrender.com'].some((domain) => h === domain || h.endsWith(`.${domain}`));
}

export function refuseSharedTargets(...urls: (string | undefined)[]): void {
  for (const url of urls) {
    if (!url) continue;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (isRenderHost(host)) {
      console.error(`Refusing to run load-test tooling against a Render host (${host}).`);
      process.exit(2);
    }
  }
}
