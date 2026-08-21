import type { IncomingMessage } from 'node:http';

// ===================== Client identity and rate-limit keying =====================
// Shared by server.ts and feedback.ts so the two limiters cannot drift apart.
//
// The problem this module exists to solve: req.socket.remoteAddress is the
// address of the immediate TCP peer. On Render that is the edge proxy, not the
// visitor. Keying a rate limiter on it collapses the entire internet into one
// bucket -- so nobody is protected and, once there is real traffic, everybody
// gets 429s. The privacy-truncated log field was truncating the proxy's address
// too, which is to say it carried no information at all.
//
// Environment:
//   TRUSTED_PROXY_HOPS   proxy hops we control in front of the app.
//                        Render: 1. Local dev / direct: 0. If Cloudflare is
//                        ever put in front of the API as well, this becomes 2 --
//                        which is exactly why it is a variable and not a
//                        literal. Setting it too HIGH is the dangerous
//                        direction: it starts trusting a client-supplied value.
//   MAX_RATE_LIMIT_KEYS  hard cap on tracked buckets (default 10000)

export const TRUSTED_PROXY_HOPS = parseInt(process.env.TRUSTED_PROXY_HOPS ?? '1', 10);
export const MAX_RATE_LIMIT_KEYS = parseInt(process.env.MAX_RATE_LIMIT_KEYS ?? '10000', 10);

/** Longest possible textual IPv6 address, including an embedded IPv4 tail. */
const MAX_IP_CHARS = 45;

/** Refuse to walk an absurd header rather than splitting it into thousands of hops. */
const MAX_XFF_CHARS = 2048;

const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_PATTERN = /^[0-9a-f:.]{2,45}$/i;

/** Strip the IPv4-mapped-IPv6 prefix, brackets, and surrounding whitespace. */
export function normalizeIp(raw: string | undefined): string {
  if (!raw) return '';
  return raw.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/^::ffff:/i, '');
}

/**
 * A cheap, deliberately loose sanity check.
 *
 * This is NOT a validator for correctness -- it is a guard against unbounded
 * key cardinality. x-forwarded-for is attacker-influenced at its left end, so
 * without this a junk value becomes a fresh rate-limit bucket and the limiter
 * turns into a memory-growth vector on a small instance.
 */
export function isPlausibleIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  if (!ip || ip.length > MAX_IP_CHARS) return false;
  if (IPV4_PATTERN.test(ip)) {
    return ip.split('.').every((octet) => {
      const n = Number(octet);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }
  return ip.includes(':') && IPV6_PATTERN.test(ip);
}

/**
 * Derive the client address from x-forwarded-for, taking the RIGHTMOST
 * untrusted hop rather than the leftmost value.
 *
 * Direction is the whole point. Each proxy appends the address it received the
 * request FROM, so the rightmost entries are the ones our own infrastructure
 * wrote and the leftmost entries are whatever the client chose to send. Using
 * split(',')[0] -- the obvious implementation -- hands an attacker unlimited
 * bucket rotation, which is strictly worse than keying on the proxy.
 *
 * With TRUSTED_PROXY_HOPS = 1 and a spoofed header:
 *
 *   client sends:  x-forwarded-for: 1.2.3.4
 *   Render appends the real peer:   1.2.3.4, <real client>
 *   chain.length - 1 = index 1   -> <real client>            (spoof ignored)
 *
 * And with an honest client:
 *
 *   Render writes:  x-forwarded-for: <real client>
 *   chain.length - 1 = index 0   -> <real client>
 *
 * A chain SHORTER than the expected hop count means the header did not come
 * from the infrastructure we think it did, so the socket address is used
 * instead of guessing.
 */
export function getClientIp(req: IncomingMessage): string {
  const socketIp = normalizeIp(req.socket.remoteAddress) || 'unknown';

  const hops = Number.isFinite(TRUSTED_PROXY_HOPS) ? TRUSTED_PROXY_HOPS : 1;
  if (hops <= 0) return socketIp; // direct exposure: the socket IS the client

  const raw = req.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : raw;
  if (!header || header.length > MAX_XFF_CHARS) return socketIp;

  const chain = header.split(',').map(normalizeIp).filter(Boolean);
  const index = chain.length - hops;
  if (index < 0 || index >= chain.length) return socketIp;

  const candidate = chain[index];
  return isPlausibleIp(candidate) ? candidate : socketIp;
}

/** Zero-pad an IPv6 group so slicing a prefix compares like for like. */
const pad4 = (group: string): string => group.toLowerCase().padStart(4, '0');

/**
 * Expand a compressed IPv6 address into its eight groups, or null if it does
 * not parse. Needed because a prefix cannot be taken from a compressed form:
 * the first four groups of '2001:db8::1' are not '2001:db8::1'.
 */
function expandIpv6(ip: string): string[] | null {
  if (ip.includes('.')) return null; // embedded IPv4 -- treat as a whole
  const halves = ip.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  if (halves.length === 1) {
    return head.length === 8 ? head.map(pad4) : null;
  }

  const tail = halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;

  return [...head, ...new Array<string>(missing).fill('0'), ...tail].map(pad4);
}

/**
 * The bucket key for an address.
 *
 * IPv6 clients are collapsed to their /64 prefix. A routed /64 is the normal
 * residential and hosting allocation, so without this an attacker rotates
 * source addresses inside their own subnet and bypasses the limit entirely --
 * per-IP limiting on full IPv6 addresses is close to no limiting at all.
 *
 * IPv4 is used whole: a /24 would put unrelated households in one bucket.
 */
export function rateLimitKey(ip: string): string {
  const normalized = normalizeIp(ip) || 'unknown';
  if (!normalized.includes(':')) return normalized;

  const groups = expandIpv6(normalized);
  if (!groups) return normalized;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/**
 * Coarsen an address before it reaches a log line: IPv4 loses its last octet,
 * IPv6 keeps /48.
 *
 * Note this is deliberately coarser than the /64 used for rate limiting. The
 * two answer different questions -- one is an abuse-control key that has to
 * distinguish neighbours, the other is a log field that should not.
 */
export function truncateIp(raw: string | undefined): string {
  const ip = normalizeIp(raw);
  if (!ip) return 'unknown';
  if (ip.includes('.') && !ip.includes(':')) {
    const parts = ip.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : 'unknown';
  }
  if (ip.includes(':')) {
    const groups = expandIpv6(ip);
    if (groups) return `${groups.slice(0, 3).join(':')}::/48`;
    return `${ip.split(':').slice(0, 3).join(':')}::/48`;
  }
  return 'unknown';
}

// ===================== Bounded fixed-window limiter =====================

export interface RateLimitVerdict {
  ok: boolean;
  retryAfter: number;
  remaining: number;
}

export interface RateLimiter {
  hit: (key: string) => RateLimitVerdict;
  sweep: (now?: number) => void;
  size: () => number;
  stop: () => void;
}

/**
 * All overflow traffic shares this one bucket. Falling back to a shared bucket
 * when the map is full is the safe direction: it degrades to the OLD (bad)
 * behaviour for the excess only, instead of letting an attacker with rotating
 * addresses grow the map until the 512 MB instance dies.
 */
const OVERFLOW_KEY = '__overflow__';

export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  maxKeys?: number;
}): RateLimiter {
  const { windowMs, max } = options;
  const maxKeys = options.maxKeys ?? MAX_RATE_LIMIT_KEYS;
  const buckets = new Map<string, { count: number; resetAt: number }>();

  function sweep(now: number = Date.now()): void {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  function hit(key: string): RateLimitVerdict {
    const now = Date.now();

    // Only sweep on the path that would otherwise grow the map, so the common
    // case stays a single map lookup.
    let effective = key;
    if (!buckets.has(key) && buckets.size >= maxKeys) {
      sweep(now);
      if (!buckets.has(key) && buckets.size >= maxKeys) effective = OVERFLOW_KEY;
    }

    let bucket = buckets.get(effective);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(effective, bucket);
    }
    bucket.count++;

    return {
      ok: bucket.count <= max,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      remaining: Math.max(0, max - bucket.count),
    };
  }

  const timer = setInterval(() => sweep(), windowMs).unref();

  return { hit, sweep, size: () => buckets.size, stop: () => clearInterval(timer) };
}
