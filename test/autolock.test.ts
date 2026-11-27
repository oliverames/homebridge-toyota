import { describe, expect, it } from 'vitest';
import { AUTO_LOCK, type AutoLockState, decideAutoLock, emptyAutoLockState } from '../src/autolock';
import type { RemoteStatus } from '../src/parse';

const MIN = 60_000;
const NOW = Date.parse('2026-11-27T22:00:00Z');
const status = (locked: boolean | null, opts: { ageMs?: number; open?: 'door' | 'trunk' | 'hood' | 'window' } = {}): RemoteStatus => ({
  doorsLocked: locked,
  reportedAtMs: NOW - (opts.ageMs ?? MIN),
  openings: [
    { key: 'door:door', kind: 'door', label: 'Door', open: opts.open === 'door', locked },
    { key: 'trunk:hatch', kind: 'trunk', label: 'Hatch', open: opts.open === 'trunk', locked: null },
    { key: 'hood:hood', kind: 'hood', label: 'Hood', open: opts.open === 'hood', locked: null },
    { key: 'window:window', kind: 'window', label: 'Window', open: opts.open === 'window', locked: null },
  ],
});
const parked = { speed: 0, reportedAtMs: NOW - MIN };
const ready = (): AutoLockState => ({ ...emptyAutoLockState(), unlockedSince: NOW - 30 * MIN });
const decide = (state: AutoLockState, s: RemoteStatus, extra: Partial<Parameters<typeof decideAutoLock>[1]> = {}) =>
  decideAutoLock(state, { status: s, telemetry: parked, running: false, now: NOW, afterMs: 10 * MIN, ...extra });

describe('auto-lock policy', () => {
  it('locks an unlocked, parked, closed, idle car with fresh evidence', () => {
    expect(decide(ready(), status(false))).toEqual({ action: 'lock' });
  });
  it('a locked report ends the episode', () => {
    const state: AutoLockState = { ...ready(), attempts: 3, evidenceWakes: 3, lastAttempt: NOW - MIN };
    decide(state, status(true));
    expect(state).toEqual({ attempts: 0, evidenceWakes: 0, unlockedSince: undefined, lastAttempt: undefined, lastEvidenceWake: undefined });
  });
  it('waits until the doors have been unlocked long enough, counting from the report time', () => {
    const state = emptyAutoLockState();
    expect(decide(state, status(false, { ageMs: 2 * MIN }))).toMatchObject({ action: 'none', reason: 'not unlocked long enough' });
    expect(state.unlockedSince).toBe(NOW - 2 * MIN);
  });
  it('stands down after a HomeKit unlock, during cooldown, and at the attempt cap', () => {
    expect(decide({ ...ready(), lastUserUnlock: NOW - 5 * MIN }, status(false)).action).toBe('none');
    expect(decide({ ...ready(), lastAttempt: NOW - 5 * MIN, attempts: 1 }, status(false)).action).toBe('none');
    expect(decide({ ...ready(), lastAttempt: NOW - 30 * MIN, attempts: AUTO_LOCK.maxAttempts }, status(false)).action).toBe('none');
  });
  it('the attempt cap resets six hours after the last attempt', () => {
    const state = { ...ready(), lastAttempt: NOW - 7 * 60 * MIN, attempts: AUTO_LOCK.maxAttempts };
    expect(decide(state, status(false)).action).toBe('lock');
  });
  it('never locks with a door, the hatch or the hood open, or with the engine running; a window does not block', () => {
    for (const open of ['door', 'trunk', 'hood'] as const) {
      expect(decide(ready(), status(false, { open })).action).toBe('none');
    }
    expect(decide(ready(), status(false), { running: true }).action).toBe('none');
    expect(decide(ready(), status(false, { open: 'window' })).action).toBe('lock');
  });
  it('asks for a fresh report when the lock report or telemetry is old, within its own limits', () => {
    expect(decide(ready(), status(false, { ageMs: 20 * MIN })).action).toBe('wake');
    expect(decide(ready(), status(false), { telemetry: { speed: 0, reportedAtMs: NOW - 20 * MIN } }).action).toBe('wake');
    expect(decide({ ...ready(), evidenceWakes: AUTO_LOCK.maxEvidenceWakes }, status(false, { ageMs: 20 * MIN })).action).toBe('none');
    expect(decide({ ...ready(), evidenceWakes: 1, lastEvidenceWake: NOW - 5 * MIN }, status(false, { ageMs: 20 * MIN })).action).toBe('none');
  });
  it('fails closed on unknown speed or lock state, and never locks a moving car', () => {
    expect(decide(ready(), status(false), { telemetry: { reportedAtMs: NOW } }).action).toBe('none');
    expect(decide(ready(), status(false), { telemetry: { speed: 5, reportedAtMs: NOW } }).action).toBe('none');
    expect(decide(ready(), status(null)).action).toBe('none');
    expect(decide(ready(), status(false), { running: undefined })).toMatchObject({ action: 'none', reason: 'the engine state is unknown' });
  });
});
