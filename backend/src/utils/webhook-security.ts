// Webhook security primitives for facility notifications (Phase 5, issue #126).
//
// - Registration and delivery accept only HTTPS URLs.
// - Requests never go to private, loopback, link-local, or metadata addresses
//   (SSRF). This module checks IP literals. Delivery must also resolve the
//   hostname and check the address it actually connects to, to defeat DNS
//   rebinding. That check belongs to the delivery worker, not here.
// - Each payload is signed with HMAC-SHA256 over `<timestamp>.<body>`. The
//   signature header is `t=<unix seconds>,v1=<hex digest>`, so a receiver can
//   reject replays by checking the timestamp.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const SIGNATURE_VERSION = 'v1';

/** Thrown when a webhook URL or address is not allowed. Callers map it to 422. */
export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookUrlError';
  }
}

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function inIpv4Range(address: string, base: string, prefixBits: number): boolean {
  const mask = prefixBits === 0 ? 0 : (0xffffffff << (32 - prefixBits)) >>> 0;
  return ((ipv4ToInt(address) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}

const BLOCKED_IPV4: [string, number][] = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

/**
 * True when an IP literal must never be contacted by a webhook. Covers
 * private, loopback, link-local, multicast, and reserved ranges for IPv4 and
 * IPv6, including IPv4-mapped IPv6 addresses. Returns true for anything that
 * is not a valid IP literal, so the caller fails closed.
 */
export function isBlockedWebhookAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return BLOCKED_IPV4.some(([base, bits]) => inIpv4Range(address, base, bits));
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedWebhookAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
    if (/^ff/.test(lower)) return true; // ff00::/8 multicast
    return false;
  }
  return true;
}

/**
 * Validate a webhook endpoint URL at registration time. Requires `https:`,
 * rejects embedded credentials, and rejects an IP-literal host in a blocked
 * range. Hostnames are not resolved here.
 */
export function assertWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError('Webhook URL must be a valid absolute URL.');
  }
  if (url.protocol !== 'https:') {
    throw new WebhookUrlError('Webhook URL must use HTTPS.');
  }
  if (url.username || url.password) {
    throw new WebhookUrlError('Webhook URL must not contain credentials.');
  }
  // URL keeps brackets on IPv6 hosts; strip them before checking the literal.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (isIP(host) && isBlockedWebhookAddress(host)) {
    throw new WebhookUrlError('Webhook URL must not point to a private or reserved address.');
  }
  return url;
}

/** Build the `t=…,v1=…` signature header for a payload sent at `timestamp` (unix seconds). */
export function signWebhookPayload(secret: string, body: string, timestamp: number): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},${SIGNATURE_VERSION}=${digest}`;
}

/**
 * Check a received signature header. Rejects a malformed header, a timestamp
 * outside `toleranceSeconds` (replay protection), or a digest mismatch. The
 * digest comparison is constant-time.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=') as [string, string]));
  const timestamp = Number(parts.t);
  const received = parts[SIGNATURE_VERSION];
  if (!Number.isInteger(timestamp) || !received) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const expected = signWebhookPayload(secret, body, timestamp).split(`${SIGNATURE_VERSION}=`)[1];
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(received, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Exponential backoff for redelivery: 30s, 60s, 120s, … capped at six hours.
 * `attempt` is 1 for the first retry.
 */
export function webhookRetryDelaySeconds(attempt: number): number {
  const BASE_SECONDS = 30;
  const CAP_SECONDS = 6 * 60 * 60;
  return Math.min(CAP_SECONDS, BASE_SECONDS * 2 ** Math.max(0, attempt - 1));
}
