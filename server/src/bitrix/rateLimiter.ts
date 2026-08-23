/**
 * Global token-bucket rate limiter (PRD Section 10.3).
 *
 * Bitrix's 2 req/sec is per *portal*, so exactly one limiter instance must
 * gate every real Bitrix HTTP call regardless of which client method triggers
 * it. Capacity = rate (a small burst), refilled continuously.
 *
 * The clock and sleep are injectable so throughput is unit-testable without
 * wall-clock flakiness.
 */

export interface RateLimiterOptions {
  ratePerSec: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  private readonly rate: number;
  private readonly capacity: number;
  private tokens: number;
  private last: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Serializes waiters so tokens are handed out in call order (FIFO). */
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: RateLimiterOptions) {
    this.rate = Math.max(0.001, opts.ratePerSec);
    this.capacity = Math.max(1, opts.ratePerSec);
    this.tokens = this.capacity;
    this.now = opts.now ?? Date.now;
    this.last = this.now();
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private refill(): void {
    const t = this.now();
    const elapsedSec = (t - this.last) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.rate);
      this.last = t;
    }
  }

  /** Resolve once a token is available, consuming it. FIFO across callers. */
  async acquire(): Promise<void> {
    // Link onto the chain so concurrent callers are spaced, not simultaneous.
    const prior = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => (release = r));
    await prior;
    try {
      // Loop in case of scheduler jitter.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const needed = 1 - this.tokens;
        const waitMs = Math.ceil((needed / this.rate) * 1000);
        await this.sleep(waitMs);
      }
    } finally {
      release();
    }
  }

  /** Convenience: acquire a token, then run `fn`. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    return fn();
  }
}
