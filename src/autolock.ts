import type { RemoteStatus, Telemetry } from './parse';

/**
 * Auto-lock, ported from RedLink's `ToyotaAutoLock`. Toyota exposes no key or
 * fob proximity, gear or ignition signal, so "parked and not in use" is
 * inferred: fresh zero-speed telemetry, every door, the hatch and the hood
 * closed, and no engine or climate running. The vehicle's own interlock also
 * refuses a remote lock while a key is inside. One addition over RedLink: the
 * doors must have been reported unlocked for `afterMs` first, because this
 * runs unattended on every poll, not only when an app happens to refresh.
 */
export const AUTO_LOCK = {
  /** Both the lock report and the parked evidence must be this recent before an unattended lock. */
  maxObservationAgeMs: 5 * 60 * 1000,
  /** Minimum spacing between attempts. */
  attemptCooldownMs: 10 * 60 * 1000,
  /** After an unlock from HomeKit, stand down this long rather than fight it. */
  userUnlockGraceMs: 15 * 60 * 1000,
  /** Attempts per unlocked episode; a key left inside makes the car refuse every time. */
  maxAttempts: 3,
  /** Fresh-report requests per episode, so an unlocked car is not woken every 15 minutes all night. */
  maxEvidenceWakes: 3,
  /** An episode that never saw the car locked starts over this long after its last attempt or wake. */
  episodeResetMs: 6 * 60 * 60 * 1000,
  /** Minimum spacing between fresh-report requests made for auto-lock. */
  wakeIntervalMs: 15 * 60 * 1000,
} as const;

export const DEFAULT_AUTO_LOCK_MINUTES = 10;

export interface AutoLockState {
  /** Earliest report time at which the doors were seen unlocked in this episode. */
  unlockedSince?: number;
  lastAttempt?: number;
  attempts: number;
  evidenceWakes: number;
  lastEvidenceWake?: number;
  /** The last unlock sent from HomeKit. */
  lastUserUnlock?: number;
}

export interface AutoLockStore {
  load(): AutoLockState | undefined;
  save(state: AutoLockState): void;
}

export function isAutoLockState(v: unknown): v is AutoLockState {
  return typeof v === 'object' && v !== null && typeof (v as AutoLockState).attempts === 'number' && typeof (v as AutoLockState).evidenceWakes === 'number';
}

export const emptyAutoLockState = (): AutoLockState => ({ attempts: 0, evidenceWakes: 0 });

export interface AutoLockInput {
  status: RemoteStatus;
  telemetry?: Telemetry;
  running?: boolean;
  now: number;
  afterMs: number;
}

export type AutoLockDecision = { action: 'lock' } | { action: 'wake' } | { action: 'none'; reason: string };

const fresh = (at: number | undefined, now: number): boolean => at !== undefined && now - at >= -60_000 && now - at <= AUTO_LOCK.maxObservationAgeMs;

/**
 * Decides one step and updates the episode bookkeeping in `state` (the caller
 * saves it). Deliberately not edge-triggered, as in RedLink: any observation of
 * "unlocked, parked and idle" is enough, and the cooldown and caps bound it.
 */
export function decideAutoLock(state: AutoLockState, input: AutoLockInput): AutoLockDecision {
  const { status, telemetry, running, now } = input;
  if (status.doorsLocked === true) {
    // A locked car ends the episode.
    state.unlockedSince = undefined;
    state.lastAttempt = undefined;
    state.lastEvidenceWake = undefined;
    state.attempts = 0;
    state.evidenceWakes = 0;
    return { action: 'none', reason: 'locked' };
  }
  if (status.doorsLocked !== false) {
    return { action: 'none', reason: 'lock state unknown' };
  }
  const seenUnlockedAt = status.reportedAtMs ?? now;
  state.unlockedSince = Math.min(state.unlockedSince ?? seenUnlockedAt, seenUnlockedAt);

  const lastActivity = Math.max(state.lastAttempt ?? 0, state.lastEvidenceWake ?? 0);
  if (lastActivity > 0 && now - lastActivity >= AUTO_LOCK.episodeResetMs) {
    state.attempts = 0;
    state.evidenceWakes = 0;
  }
  if (state.lastUserUnlock !== undefined && now - state.lastUserUnlock < AUTO_LOCK.userUnlockGraceMs) {
    return { action: 'none', reason: 'unlocked from HomeKit recently' };
  }
  if (now - state.unlockedSince < input.afterMs) {
    return { action: 'none', reason: 'not unlocked long enough' };
  }
  if (state.lastAttempt !== undefined && now - state.lastAttempt < AUTO_LOCK.attemptCooldownMs) {
    return { action: 'none', reason: 'cooling down after an attempt' };
  }
  if (state.attempts >= AUTO_LOCK.maxAttempts) {
    return { action: 'none', reason: 'attempt limit reached for this unlock' };
  }
  // An open door, hatch or hood: someone is likely loading the car, and it would not lock anyway.
  if (status.openings.some((o) => (o.kind === 'door' || o.kind === 'trunk' || o.kind === 'hood') && o.open === true)) {
    return { action: 'none', reason: 'something is open' };
  }
  if (running === true) {
    return { action: 'none', reason: 'the engine or climate is running' };
  }
  if (!fresh(status.reportedAtMs, now) || !fresh(telemetry?.reportedAtMs, now)) {
    if (state.evidenceWakes >= AUTO_LOCK.maxEvidenceWakes) {
      return { action: 'none', reason: 'fresh-report limit reached for this unlock' };
    }
    if (state.lastEvidenceWake !== undefined && now - state.lastEvidenceWake < AUTO_LOCK.wakeIntervalMs) {
      return { action: 'none', reason: 'waiting for a fresh report' };
    }
    return { action: 'wake' };
  }
  // Unattended, so an unknown movement state fails closed.
  if (telemetry?.speed === undefined) {
    return { action: 'none', reason: 'the vehicle does not report its speed' };
  }
  if (telemetry.speed > 0.01) {
    return { action: 'none', reason: 'the vehicle is moving' };
  }
  return { action: 'lock' };
}
