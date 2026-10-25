/**
 * Fixed-window in-memory rate limiter. Sufficient for a single application
 * instance; swap for a shared store (Redis/Mongo TTL collection) when scaling out.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

const g = globalThis as unknown as { __hrRate?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = (g.__hrRate ??= new Map());

export function hit(key: string, limit: number, windowMs: number): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  if (buckets.size > 10000) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count), retryAfterMs: b.resetAt - now };
}

export function resetRateLimits() {
  buckets.clear();
}
