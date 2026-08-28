/**
 * Fixed-window rate limiter, in memory.
 *
 * Expired entries are purged on every pass: an IP forged per request cannot
 * grow the table indefinitely. Beyond `maxKeys` the limiter refuses
 * (fail-closed) rather than accepting without counting.
 *
 * Scope: a single process. See "security model" in the README.
 */

type Bucket = { count: number; resetAt: number };

export type RateVerdict = { allowed: true } | { allowed: false; retryAfter: number };

export class FixedWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  private prune(now: number) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  check(key: string, now = Date.now()): RateVerdict {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) return { allowed: true };
    if (bucket.count < this.limit) return { allowed: true };
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }

  /** Increments the counter and returns the verdict for THIS request. */
  consume(key: string, now = Date.now()): RateVerdict {
    this.prune(now);

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (this.buckets.size >= this.maxKeys) {
        return { allowed: false, retryAfter: Math.ceil(this.windowMs / 1000) };
      }
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true };
    }

    bucket.count += 1;
    if (bucket.count > this.limit) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    return { allowed: true };
  }

  reset(key: string) {
    this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }
}
