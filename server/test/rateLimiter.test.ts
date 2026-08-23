import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../src/bitrix/rateLimiter.js';

/** Virtual clock: `now` advances only when `sleep` is called. */
function virtualClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('RateLimiter', () => {
  it('allows an initial burst up to capacity, then throttles', async () => {
    const clk = virtualClock();
    const rl = new RateLimiter({ ratePerSec: 2, now: clk.now, sleep: clk.sleep });
    // Burst of 2 at t=0 (capacity=2), no sleep needed.
    await rl.acquire();
    await rl.acquire();
    expect(clk.now()).toBe(0);
    // 3rd must wait ~500ms for a refill at 2/sec.
    await rl.acquire();
    expect(clk.now()).toBeGreaterThanOrEqual(500);
  });

  it('spaces N calls at approximately the configured rate', async () => {
    const clk = virtualClock();
    const rl = new RateLimiter({ ratePerSec: 2, now: clk.now, sleep: clk.sleep });
    const N = 10;
    for (let i = 0; i < N; i++) await rl.acquire();
    // After the 2-token burst, the remaining 8 need ~500ms each => >= 4000ms.
    expect(clk.now()).toBeGreaterThanOrEqual(4000);
  });

  it('run() executes the fn after acquiring', async () => {
    const clk = virtualClock();
    const rl = new RateLimiter({ ratePerSec: 5, now: clk.now, sleep: clk.sleep });
    const out = await rl.run(async () => 42);
    expect(out).toBe(42);
  });
});
