import assert from "node:assert/strict";
import test from "node:test";
import {
  RateLimiter,
  createYouTubeApiLimiter,
  createYtDlpLimiter,
  createGeneralLimiter,
} from "../lib/rate-limiter.js";

test("acquire succeeds immediately when tokens available", async () => {
  const limiter = new RateLimiter({
    maxTokens: 10,
    refillRate: 1,
    refillIntervalMs: 1000,
  });
  const waitMs = await limiter.acquire();
  assert.equal(waitMs, 0);
  // refill() accrues fractional tokens continuously, so compare whole tokens.
  assert.equal(Math.floor(limiter.available()), 9);
});

test("acquire blocks when bucket is empty", async () => {
  const limiter = new RateLimiter({
    maxTokens: 1,
    refillRate: 1,
    refillIntervalMs: 100, // fast refill for test speed
  });

  // Drain the bucket
  await limiter.acquire();

  const start = Date.now();
  const waitMs = await limiter.acquire();
  const elapsed = Date.now() - start;

  assert.ok(waitMs > 0, `expected positive wait, got ${waitMs}`);
  assert.ok(elapsed >= 50, `expected elapsed >= 50ms, got ${elapsed}ms`);
});

test("tryAcquire returns false when empty", () => {
  const limiter = new RateLimiter({
    maxTokens: 1,
    refillRate: 1,
    refillIntervalMs: 60_000,
  });
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), false);
});

test("tokens refill over time", async () => {
  const limiter = new RateLimiter({
    maxTokens: 5,
    refillRate: 5,
    refillIntervalMs: 100,
  });

  // Drain all tokens
  for (let i = 0; i < 5; i++) limiter.tryAcquire();
  assert.equal(Math.floor(limiter.available()), 0);

  // Wait for a refill interval
  await new Promise((r) => setTimeout(r, 120));

  const avail = limiter.available();
  assert.ok(avail > 0, `expected tokens to refill, got ${avail}`);
});

test("stats track correctly", async () => {
  const limiter = new RateLimiter({
    maxTokens: 5,
    refillRate: 5,
    refillIntervalMs: 100,
  });

  await limiter.acquire();
  await limiter.acquire();
  limiter.tryAcquire();
  // Drain remaining
  limiter.tryAcquire();
  limiter.tryAcquire();
  // This should be denied
  const denied = limiter.tryAcquire();
  assert.equal(denied, false);

  const s = limiter.stats();
  assert.equal(s.totalAcquired, 5);
  assert.equal(s.totalDenied, 1);
});

test("reset restores full capacity", () => {
  const limiter = new RateLimiter({
    maxTokens: 10,
    refillRate: 1,
    refillIntervalMs: 60_000,
  });

  for (let i = 0; i < 10; i++) limiter.tryAcquire();
  assert.equal(Math.floor(limiter.available()), 0);

  limiter.reset();
  assert.equal(limiter.available(), 10);

  const s = limiter.stats();
  assert.equal(s.totalAcquired, 0);
  assert.equal(s.totalDenied, 0);
  assert.equal(s.totalWaitMs, 0);
});

test("cost parameter deducts correct amount", async () => {
  const limiter = new RateLimiter({
    maxTokens: 10,
    refillRate: 1,
    refillIntervalMs: 60_000,
  });

  await limiter.acquire(3);
  assert.equal(Math.floor(limiter.available()), 7);

  assert.equal(limiter.tryAcquire(7), true);
  assert.equal(Math.floor(limiter.available()), 0);

  assert.equal(limiter.tryAcquire(1), false);
});

test("acquire rejects cost exceeding maxTokens", async () => {
  const limiter = new RateLimiter({
    maxTokens: 5,
    refillRate: 1,
    refillIntervalMs: 1000,
  });

  await assert.rejects(() => limiter.acquire(10), /exceeds max bucket capacity/);
});

test("concurrent acquires never over-admit or drive tokens negative", async () => {
  // 2 tokens per 100ms. Start with a full bucket of 2, then fire 10 acquires at
  // once: 2 pass immediately, the other 8 must be spaced by the refill rate.
  const limiter = new RateLimiter({
    maxTokens: 2,
    refillRate: 2,
    refillIntervalMs: 100,
  });

  const start = Date.now();
  const waits = await Promise.all(
    Array.from({ length: 10 }, () => limiter.acquire()),
  );

  // Never negative at any point: available() must be >= 0 and the bucket
  // must not have handed out more than it had.
  assert.ok(limiter.available() >= 0, `available went negative: ${limiter.available()}`);

  // Exactly 2 should have been immediate (wait 0); the rest waited.
  const immediate = waits.filter((w) => w === 0).length;
  assert.equal(immediate, 2, `expected 2 immediate admissions, got ${immediate}`);

  // 10 admissions at 2 per 100ms starting from a full bucket of 2 => the last
  // 8 need ~4 refill intervals (~400ms). Assert real elapsed spacing occurred.
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 300, `expected admissions to be spaced (>=300ms), got ${elapsed}ms`);

  const s = limiter.stats();
  assert.equal(s.totalAcquired, 10);
});

test("factory: createYouTubeApiLimiter creates limiter with 50 burst capacity", () => {
  const limiter = createYouTubeApiLimiter();
  assert.equal(limiter.available(), 50);
});

test("factory: createYtDlpLimiter creates limiter with 10 burst capacity", () => {
  const limiter = createYtDlpLimiter();
  assert.equal(limiter.available(), 10);
});

test("factory: createGeneralLimiter creates limiter with 20 burst capacity", () => {
  const limiter = createGeneralLimiter();
  assert.equal(limiter.available(), 20);
});
