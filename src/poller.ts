export interface BackoffInput {
  baseMs: number;
  consecutiveFailures: number;
  rateLimited: boolean;
  /** 0..1, injected so the function stays deterministic. */
  jitter?: number;
}

export const MAX_BACKOFF_MS = 60 * 60 * 1000;
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

export type PollOutcome = 'ok' | 'failed' | 'rateLimited';

/** Self-rescheduling poll loop. The task must report its outcome and must never throw. */
export class Poller {
  private timer?: NodeJS.Timeout;
  private failures = 0;
  private stopped = true;

  constructor(
    private readonly task: () => Promise<PollOutcome>,
    private readonly baseMs: number,
    private readonly random: () => number = Math.random,
  ) {}

  start(initialDelayMs = 0): void {
    this.stopped = false;
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
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    let outcome: PollOutcome;
    try {
      outcome = await this.task();
    } catch {
      outcome = 'failed';
    }
    this.failures = outcome === 'ok' ? 0 : this.failures + 1;
    this.schedule(
      nextDelayMs({
        baseMs: this.baseMs,
        consecutiveFailures: this.failures,
        rateLimited: outcome === 'rateLimited',
        jitter: this.random(),
      }),
    );
  }
}
