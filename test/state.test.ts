import { describe, expect, it, vi } from 'vitest';
import { nextDelayMs, MAX_BACKOFF_MS, Poller, RATE_LIMIT_FLOOR_MS } from '../src/poller';
import {
  batteryState,
  CHARGING,
  contactState,
  CONTACT_DETECTED,
  CONTACT_NOT_DETECTED,
  lockCommandConfirmed,
  lockCurrentState,
  lockTargetState,
  LOCK_SECURED,
  LOCK_UNKNOWN,
  LOCK_UNSECURED,
  NOT_CHARGING,
} from '../src/state';

describe('lock mapping', () => {
  it('maps reported state, with unknown kept honest', () => {
    expect(lockCurrentState(true)).toBe(LOCK_SECURED);
    expect(lockCurrentState(false)).toBe(LOCK_UNSECURED);
    expect(lockCurrentState(null)).toBe(LOCK_UNKNOWN);
    expect(lockTargetState(null, LOCK_SECURED)).toBe(LOCK_SECURED);
    expect(lockTargetState(false, LOCK_SECURED)).toBe(LOCK_UNSECURED);
  });
  it('confirms a command only when the report matches', () => {
    expect(lockCommandConfirmed(true, true)).toBe(true);
    expect(lockCommandConfirmed(true, false)).toBe(false);
    expect(lockCommandConfirmed(true, null)).toBe(false);
  });
});

describe('contact and battery mapping', () => {
  it('open means contact not detected; unknown keeps last value', () => {
    expect(contactState(true)).toBe(CONTACT_NOT_DETECTED);
    expect(contactState(false)).toBe(CONTACT_DETECTED);
    expect(contactState(null)).toBeUndefined();
  });
  it('battery only from a real reading', () => {
    expect(batteryState({})).toBeUndefined();
    expect(batteryState({ batteryPercent: 64.4, charging: true })).toEqual({ level: 64, lowBattery: false, chargingState: CHARGING });
    expect(batteryState({ batteryPercent: 20 })).toEqual({ level: 20, lowBattery: true, chargingState: NOT_CHARGING });
  });
});

describe('backoff', () => {
  const base = 5 * 60_000;
  it('keeps the interval when healthy', () => {
    expect(nextDelayMs({ baseMs: base, consecutiveFailures: 0, rateLimited: false })).toBe(base);
  });
  it('doubles per failure and caps at one hour', () => {
    expect(nextDelayMs({ baseMs: base, consecutiveFailures: 1, rateLimited: false })).toBe(base * 2);
    expect(nextDelayMs({ baseMs: base, consecutiveFailures: 2, rateLimited: false })).toBe(base * 4);
    expect(nextDelayMs({ baseMs: base, consecutiveFailures: 20, rateLimited: false })).toBe(MAX_BACKOFF_MS);
  });
  it('never retries a 429 sooner than the floor', () => {
    expect(nextDelayMs({ baseMs: base, consecutiveFailures: 1, rateLimited: true })).toBe(RATE_LIMIT_FLOOR_MS);
  });
  it('applies jitter upward only', () => {
    expect(nextDelayMs({ baseMs: base, consecutiveFailures: 0, rateLimited: false, jitter: 1 })).toBe(Math.round(base * 1.1));
  });
});

describe('Poller fast follow-up', () => {
  it('hurry() pulls a long healthy wait in to a minute and keeps minute polls until the window ends', async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const poller = new Poller(async () => { runs++; return 'ok'; }, 5 * 60_000, () => 0, () => Date.now());
      poller.start(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(runs).toBe(1);
      poller.hurry(Date.now() + 3 * 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runs).toBe(2);
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(runs).toBe(4);
      // The window is over: back to the 5 minute interval.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runs).toBe(4);
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(runs).toBe(5);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cut short a backoff after failures', async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const poller = new Poller(async () => { runs++; return 'failed'; }, 5 * 60_000, () => 0, () => Date.now());
      poller.start(0);
      await vi.advanceTimersByTimeAsync(0);
      poller.hurry(Date.now() + 10 * 60_000);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(runs).toBe(1);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
