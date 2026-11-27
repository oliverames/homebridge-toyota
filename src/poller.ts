export interface BackoffInput {
  baseMs: number;
  consecutiveFailures: number;
  rateLimited: boolean;
  /** 0..1, injected so the function stays deterministic. */
  jitter?: number;
}

export const MAX_BACKOFF_MS = 60 * 60 * 1000;
/** Interval while something just happened (a command, a wake, the engine running). Reads are cached GETs. */
export const FAST_POLL_MS = 60 * 1000;
/** How long fast polling lasts after the latest activity. */
export const FAST_POLL_WINDOW_MS = 10 * 60 * 1000;
export const RATE_LIMIT_FLOOR_MS = 15 * 60 * 1000;

/**
 * Delay before the next poll. Healthy polls keep the configured interval; each
 * consecutive failure doubles it (capped at one hour). A 429 never retries
 * sooner than 15 minutes.
 */
export function nextDelayMs({ baseMs, consecutiveFailures, rateLimited, jitter = 0 }: BackoffInput): number {
  let delay = baseMs;
  if (consecutiveFailures > 0) {
    delay = Math.min(baseMs * 2 ** Math.min(consecutiveFailures, 8), MAX_BACKOFF_MS);
  }
  if (rateLimited) {
    delay = Math.max(delay, RATE_LIMIT_FLOOR_MS);
  }
  return Math.round(delay * (1 + 0.1 * jitter));
}

/** `fatal` stops polling until restarted, by Homebridge or by the platform when a new session appears (bad credentials or a pending passcode: retrying would spam Toyota). */
export type PollOutcome = 'ok' | 'failed' | 'rateLimited' | 'fatal';

/** Self-rescheduling poll loop. The task must report its outcome and must never throw. */
export class Poller {
  private timer?: NodeJS.Timeout;
  private failures = 0;
  private stopped = true;
  private running = false;
  private dueAt?: number;
  private fastUntil = 0;

  constructor(
    private readonly task: () => Promise<PollOutcome>,
    private readonly baseMs: number,
    private readonly random: () => number = Math.random,
    private readonly now: () => number = Date.now,
    private readonly debug: (message: string) => void = () => {},
  ) {}

  /**
   * Poll every minute until `until`. A healthy wait that is longer is cut short.
   * Backoff after failures and the 429 floor still win.
   */
  hurry(until: number): void {
    this.fastUntil = Math.max(this.fastUntil, until);
    if (this.stopped || this.running || this.failures > 0 || this.dueAt === undefined) {
      return;
    }
    const soonest = this.now() + FAST_POLL_MS;
    if (this.dueAt > soonest) {
      if (this.timer) {
        clearTimeout(this.timer);
      }
      this.debug(`Something just happened; updating every minute for the next ${Math.round((this.fastUntil - this.now()) / 60_000)} minutes.`);
      this.schedule(FAST_POLL_MS);
    }
  }

  start(initialDelayMs = 0): void {
    this.stopped = false;
    this.failures = 0;
    this.schedule(initialDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  get failureCount(): number {
    return this.failures;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.dueAt = this.now() + delayMs;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    let outcome: PollOutcome;
    this.running = true;
    this.dueAt = undefined;
    try {
      outcome = await this.task();
    } catch {
      outcome = 'failed';
    } finally {
      this.running = false;
    }
    if (outcome === 'fatal') {
      this.stopped = true;
      return;
    }
    this.failures = outcome === 'ok' ? 0 : this.failures + 1;
    if (outcome === 'ok' && this.now() < this.fastUntil) {
      this.schedule(FAST_POLL_MS);
      return;
    }
    const delay = nextDelayMs({
      baseMs: this.baseMs,
      consecutiveFailures: this.failures,
      rateLimited: outcome === 'rateLimited',
      jitter: this.random(),
    });
    if (this.failures > 0) {
      this.debug(`Update ${outcome} (${this.failures} in a row); next try in ${Math.round(delay / 60_000)} minutes.`);
    }
    this.schedule(delay);
  }
}
