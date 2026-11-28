import { describe, expect, it, vi } from 'vitest';
import type { VehicleApi, VehicleCommand } from '../src/api';
import { OtpRequiredError } from '../src/auth';
import { ApiHttpError, ClientKeyRejectedError } from '../src/client';
import { type ControllerListener, VehicleController, type VehicleState } from '../src/controller';
import type { ElectricStatus, RemoteStatus, Telemetry } from '../src/parse';

const locked: RemoteStatus = { openings: [], doorsLocked: true };
const unlocked: RemoteStatus = { openings: [], doorsLocked: false };
const noop = { info() {}, warn() {}, debug() {} };

class FakeApi implements VehicleApi {
  statuses: (RemoteStatus | Error)[] = [locked];
  electric: ElectricStatus | Error = { batteryPercent: 64, charging: false };
  running: (boolean | undefined | Error)[] = [false];
  sent: VehicleCommand[] = [];
  sendError?: Error;
  statusReads = 0;
  electricReads = 0;
  listVehicles = async () => [];
  async readStatus(): Promise<RemoteStatus> {
    const next = this.statuses[Math.min(this.statusReads++, this.statuses.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  }
  async readElectric(): Promise<ElectricStatus> {
    this.electricReads++;
    if (this.electric instanceof Error) throw this.electric;
    return this.electric;
  }
  async readRunning(): Promise<boolean | undefined> {
    const next = this.running.length > 1 ? this.running.shift() : this.running[0];
    if (next instanceof Error) throw next;
    return next;
  }
  async sendCommand(command: VehicleCommand): Promise<void> {
    if (this.sendError) throw this.sendError;
    this.sent.push(command);
  }
  refreshes = 0;
  refreshError?: Error;
  telemetry: Telemetry = {};
  evRefreshes = 0;
  evRefreshError?: Error;
  async requestElectricRefresh(): Promise<void> {
    this.evRefreshes++;
    if (this.evRefreshError) throw this.evRefreshError;
  }
  async readTelemetry(): Promise<Telemetry> {
    return this.telemetry;
  }
  async requestRefresh(): Promise<void> {
    this.refreshes++;
    if (this.refreshError) throw this.refreshError;
  }
}

function setup(api: FakeApi, opts: { remoteStart?: boolean; exposeBattery?: boolean; now?: () => number } = {}) {
  const events: string[] = [];
  const states: VehicleState[] = [];
  const listener: ControllerListener = {
    stateChanged: (s) => states.push(structuredClone(s)),
    commandFailed: (c, reason) => events.push(`failed:${c}:${reason}`),
  };
  const sleeps: number[] = [];
  const controller = new VehicleController(
    'VIN', '21MM', api,
    { remoteStart: opts.remoteStart ?? false, exposeBattery: opts.exposeBattery ?? true, now: opts.now, sleep: async (ms) => { sleeps.push(ms); } },
    listener, noop,
  );
  return { controller, events, states, sleeps };
}

describe('poll', () => {
  it('reads status and EV state and reports ok', async () => {
    const api = new FakeApi();
    const { controller, states } = setup(api);
    expect(await controller.poll()).toBe('ok');
    expect(states.at(-1)).toMatchObject({ status: locked, electric: { batteryPercent: 64 } });
    expect(controller.electricLike).toBe(true);
  });

  it('never throws: failures become outcomes', async () => {
    const api = new FakeApi();
    api.statuses = [new ApiHttpError(500, '')];
    expect(await setup(api).controller.poll()).toBe('failed');
    api.statuses = [new ApiHttpError(429, '')];
    expect(await setup(api).controller.poll()).toBe('rateLimited');
    api.statuses = [new OtpRequiredError()];
    expect(await setup(api).controller.poll()).toBe('fatal');
    api.statuses = [new TypeError('fetch failed')];
    expect(await setup(api).controller.poll()).toBe('failed');
  });

  it('keeps the last good state when a read fails', async () => {
    const api = new FakeApi();
    api.statuses = [locked, new ApiHttpError(503, '')];
    const { controller } = setup(api);
    await controller.poll();
    await controller.poll();
    expect(controller.state.status).toBe(locked);
  });

  it('parks the EV endpoint for 12 hours after a refusal and does not count it as a failure', async () => {
    const api = new FakeApi();
    api.electric = new ApiHttpError(404, '');
    let now = 0;
    const { controller } = setup(api, { now: () => now });
    expect(await controller.poll()).toBe('ok');
    expect(await controller.poll()).toBe('ok');
    expect(api.electricReads).toBe(1);
    now += 12 * 3_600_000 + 1;
    await controller.poll();
    expect(api.electricReads).toBe(2);
    expect(controller.state.electric).toBeUndefined();
  });

  it('a rotated client key on the EV endpoint is not counted as a poll failure, while status still reports the key problem', async () => {
    const api = new FakeApi();
    api.electric = new ClientKeyRejectedError();
    expect(await setup(api).controller.poll()).toBe('ok');
  });

  it('parks the EV endpoint only after three 403s in a row, since Toyota also answers 403 during outages', async () => {
    const api = new FakeApi();
    api.electric = new ApiHttpError(403, '');
    const { controller } = setup(api, { now: () => 0 });
    await controller.poll();
    await controller.poll();
    api.electric = { batteryPercent: 50, charging: false };
    await controller.poll();
    expect(controller.state.electric?.batteryPercent).toBe(50);
    api.electric = new ApiHttpError(403, '');
    for (let i = 0; i < 4; i++) await controller.poll();
    // Reads 1-2 refused, 3 ok (resets), 4-6 refused and parked, 7 skipped.
    expect(api.electricReads).toBe(6);
  });

  it('skips EV reads when battery is disabled and engine reads unless remote start is enabled', async () => {
    const api = new FakeApi();
    await setup(api, { exposeBattery: false }).controller.poll();
    expect(api.electricReads).toBe(0);
    const withStart = setup(api, { remoteStart: true });
    api.running = [true];
    await withStart.controller.poll();
    expect(withStart.controller.state.running).toBe(true);
  });
});

describe('lock command', () => {
  it('sends the command then confirms from the vehicle report', async () => {
    const api = new FakeApi();
    api.statuses = [locked, unlocked];
    const { controller, events, sleeps } = setup(api);
    await controller.command('unlock');
    expect(api.sent).toEqual(['unlock']);
    expect(controller.state.status?.doorsLocked).toBe(false);
    expect(events).toEqual([]);
    expect(sleeps).toEqual([10_000, 10_000]);
    expect(controller.commandPending).toBe(false);
  });

  it('polls six times over a minute, then tells HomeKit to fall back to the reported state', async () => {
    const api = new FakeApi();
    api.statuses = [locked];
    const { controller, events, sleeps } = setup(api);
    await controller.command('unlock');
    expect(sleeps).toEqual(Array(6).fill(10_000));
    expect(api.statusReads).toBe(6);
    expect(events).toEqual(['failed:unlock:not confirmed by the vehicle yet']);
    expect(controller.state.status?.doorsLocked).toBe(true);
  });

  it('reports a rejected command without verifying', async () => {
    const api = new FakeApi();
    api.sendError = new ApiHttpError(400, '{"message":"Vehicle is moving"}');
    const { controller, events } = setup(api);
    await controller.command('lock');
    expect(events[0]).toContain('failed:lock:');
    expect(events[0]).toContain('Vehicle is moving');
    expect(api.statusReads).toBe(0);
  });

  it('stops verifying if a read fails (for example 429) rather than hammering Toyota', async () => {
    const api = new FakeApi();
    api.statuses = [new ApiHttpError(429, '')];
    const { controller, events } = setup(api);
    await controller.command('unlock');
    expect(api.statusReads).toBe(1);
    expect(events).toHaveLength(1);
  });

  it('keeps confirming through a transient 503 instead of abandoning the command', async () => {
    const api = new FakeApi();
    api.statuses = [new ApiHttpError(503, ''), unlocked];
    const { controller, events } = setup(api);
    await controller.command('unlock');
    expect(api.statusReads).toBe(2);
    expect(events).toEqual([]);
    expect(controller.state.status?.doorsLocked).toBe(false);
  });

  it('quietly absorbs a repeat of the command already in flight (a second tap or Siri retry)', async () => {
    const api = new FakeApi();
    api.statuses = [locked, unlocked];
    const { controller, events } = setup(api);
    const first = controller.command('unlock');
    await controller.command('unlock');
    await controller.command('unlock');
    await first;
    expect(api.sent).toEqual(['unlock']);
    expect(events).toEqual([]);
    expect(api.statusReads).toBe(2);
  });

  it('refuses a second command while one is in flight', async () => {
    const api = new FakeApi();
    api.statuses = [locked];
    const { controller, events } = setup(api);
    const first = controller.command('unlock');
    await controller.command('lock');
    await first;
    expect(api.sent).toEqual(['unlock']);
    expect(events.some((e) => e.includes('another command is in progress'))).toBe(true);
  });
});

describe('remote start command', () => {
  it('confirms from running state', async () => {
    const api = new FakeApi();
    api.running = [false, true];
    const { controller, events } = setup(api, { remoteStart: true });
    await controller.command('remoteStart');
    expect(api.sent).toEqual(['remoteStart']);
    expect(controller.state.running).toBe(true);
    expect(events).toEqual([]);
  });
});

describe('fresh report requests', () => {
  const HOUR = 3_600_000;
  const NOW = Date.parse('2026-11-27T20:09:00Z');
  const report = (locked: boolean, ageMs: number): RemoteStatus => ({ openings: [], doorsLocked: locked, reportedAt: 'x', reportedAtMs: NOW - ageMs });

  function wakeSetup(api: FakeApi, saved?: number, staleReportMs = 3 * HOUR) {
    const lines: string[] = [];
    const store = { value: saved, load() { return this.value; }, save(v: number) { this.value = v; } };
    const states: VehicleState[] = [];
    const controller = new VehicleController(
      'VIN', '21MM', api,
      { remoteStart: false, exposeBattery: false, staleReportMs, wakeStore: store, wakeWaitDelaysMs: [0, 0, 0], now: () => NOW, sleep: async () => {} },
      { stateChanged: (s) => states.push(structuredClone(s)), commandFailed() {} },
      { info: (m) => lines.push(m), warn: (m) => lines.push(`warn:${m}`), debug() {} },
    );
    return { controller, store, lines, states };
  }

  it('leaves a recent report alone', async () => {
    const api = new FakeApi();
    api.statuses = [report(true, HOUR)];
    const { controller } = wakeSetup(api);
    expect(await controller.poll()).toBe('ok');
    expect(api.refreshes).toBe(0);
  });

  it('asks for a fresh report when the last one is stale, and shows it when it arrives', async () => {
    const api = new FakeApi();
    // Toyota's cached report says unlocked, 3.2 hours old; the car's fresh report says locked.
    api.statuses = [report(false, 3.2 * HOUR), report(false, 3.2 * HOUR), report(true, 0)];
    const { controller, store, lines, states } = wakeSetup(api);
    expect(await controller.poll()).toBe('ok');
    expect(api.refreshes).toBe(1);
    expect(store.value).toBe(NOW);
    expect(states.at(-1)?.status?.doorsLocked).toBe(true);
    expect(lines[0]).toBe("The vehicle's last report is 3.2 hours old; asking it for a fresh one.");
    expect(lines.at(-1)).toContain('sent a fresh report');
  });

  it('wakes at most once per interval, across restarts', async () => {
    const api = new FakeApi();
    api.statuses = [report(false, 5 * HOUR)];
    const { controller } = wakeSetup(api, NOW - 2 * HOUR);
    await controller.poll();
    expect(api.refreshes).toBe(0);
    const later = wakeSetup(api, NOW - 3 * HOUR);
    await later.controller.poll();
    await later.controller.poll();
    expect(api.refreshes).toBe(1);
  });

  it('a refused request is not retried until the interval passes, and a 429 backs the poller off', async () => {
    const api = new FakeApi();
    api.statuses = [report(true, 4 * HOUR)];
    api.refreshError = new ApiHttpError(429, '');
    const { controller, lines } = wakeSetup(api);
    expect(await controller.poll()).toBe('rateLimited');
    expect(await controller.poll()).toBe('ok');
    expect(api.refreshes).toBe(1);
    expect(lines.some((l) => l.startsWith('warn:Toyota refused the request for a fresh report'))).toBe(true);
  });

  it('says so when no fresh report arrives in the wait', async () => {
    const api = new FakeApi();
    api.statuses = [report(true, 4 * HOUR)];
    const { controller, lines } = wakeSetup(api);
    await controller.poll();
    expect(lines.at(-1)).toContain('has not sent a fresh report yet');
  });

  it('a report without a time counts as stale; turned off, it never wakes', async () => {
    const api = new FakeApi();
    api.statuses = [{ openings: [], doorsLocked: true }];
    await wakeSetup(api).controller.poll();
    expect(api.refreshes).toBe(1);
    const off = new FakeApi();
    off.statuses = [report(true, 10 * HOUR)];
    await wakeSetup(off, undefined, 0).controller.poll();
    expect(off.refreshes).toBe(0);
  });
});

describe('Home app wakes and activity', () => {
  const MIN = 60_000;
  const NOW = Date.parse('2026-11-27T22:00:00Z');
  function interest(ageMs: number, startedAgoMs = 10 * MIN) {
    const api = new FakeApi();
    api.statuses = [{ openings: [], doorsLocked: true, reportedAt: 't', reportedAtMs: NOW - ageMs }];
    let now = NOW - startedAgoMs;
    let activity = 0;
    const controller = new VehicleController(
      'VIN', '21MM', api,
      { remoteStart: false, exposeBattery: false, interestWakeMs: 15 * MIN, wakeWaitDelaysMs: [0], verifyDelaysMs: [0], now: () => now, sleep: async () => {}, onActivity: () => { activity++; } },
      { stateChanged() {}, commandFailed() {} }, noop,
    );
    now = NOW;
    return { api, controller, advance: (ms: number) => { now += ms; }, activity: () => activity };
  }

  it('ignores Home hub reads right after a restart', async () => {
    const t = interest(60 * MIN, 30_000);
    await t.controller.poll();
    t.controller.noteInterest();
    expect(t.api.refreshes).toBe(0);
    t.advance(2 * MIN);
    t.controller.noteInterest();
    await vi.waitFor(() => expect(t.api.refreshes).toBe(1));
  });

  it('opening the car in the Home app wakes it when the report is 15 minutes old, not when it is newer', async () => {
    const fresh = interest(5 * MIN);
    await fresh.controller.poll();
    fresh.controller.noteInterest();
    expect(fresh.api.refreshes).toBe(0);
    const old = interest(20 * MIN);
    await old.controller.poll();
    old.controller.noteInterest();
    old.controller.noteInterest();
    await vi.waitFor(() => expect(old.api.refreshes).toBe(1));
  });

  it('caps Home app wakes at eight a day', async () => {
    const t = interest(10 * 60 * MIN);
    await t.controller.poll();
    for (let i = 0; i < 12; i++) {
      t.controller.noteInterest();
      await new Promise((r) => setImmediate(r));
      t.advance(20 * MIN);
    }
    expect(t.api.refreshes).toBe(8);
  });

  it('a finished command asks for closer polling', async () => {
    const t = interest(MIN);
    await t.controller.command('lock');
    expect(t.activity()).toBe(1);
  });
});

describe('auto-lock through the controller', () => {
  const MIN = 60_000;
  const NOW = Date.parse('2026-11-27T22:00:00Z');
  const doors = (locked: boolean, ageMs: number): RemoteStatus => ({
    doorsLocked: locked, reportedAt: 't', reportedAtMs: NOW - ageMs,
    openings: [{ key: 'door:door', kind: 'door', label: 'Door', open: false, locked }],
  });
  function car(status: RemoteStatus[], telemetry: Telemetry) {
    const api = new FakeApi();
    api.statuses = status;
    api.telemetry = telemetry;
    let saved: unknown;
    const lines: string[] = [];
    const controller = new VehicleController(
      'VIN', '21MM', api,
      { remoteStart: false, exposeBattery: false, verifyDelaysMs: [0], wakeWaitDelaysMs: [0], now: () => NOW, sleep: async () => {},
        autoLock: { afterMs: 10 * MIN, store: { load: () => undefined, save: (s) => { saved = structuredClone(s); } } } },
      { stateChanged() {}, commandFailed() {} },
      { info: (m) => lines.push(m), warn: (m) => lines.push(m), debug() {} },
    );
    return { api, controller, lines, saved: () => saved };
  }

  it('does not lock a car that was only just unlocked', async () => {
    const t = car([doors(false, 2 * MIN), doors(false, 2 * MIN), doors(true, 0)], { speed: 0, reportedAtMs: NOW - MIN });
    // Unlocked since 2 minutes ago is not long enough yet.
    await t.controller.poll();
    expect(t.api.sent).toEqual([]);
  });

  it('locks once the unlock is old enough and the evidence is fresh', async () => {
    const t = car([doors(false, 3 * MIN), doors(true, 0)], { speed: 0, reportedAtMs: NOW - MIN });
    // Seen unlocked since an older report earlier in the episode.
    (t.controller as unknown as { autoLockState: object }).autoLockState = { attempts: 0, evidenceWakes: 0, unlockedSince: NOW - 30 * MIN };
    await t.controller.poll();
    expect(t.api.sent).toEqual(['lock']);
    expect(t.lines.some((l) => l.startsWith('Auto-lock: the doors have been unlocked for 30 minutes'))).toBe(true);
  });

  it('wakes the car for fresh evidence when the unlocked report is old, then locks on it', async () => {
    const t = car([doors(false, 60 * MIN), doors(false, 0), doors(true, 0)], { speed: 0, reportedAtMs: NOW });
    await t.controller.poll();
    expect(t.api.refreshes).toBe(1);
    expect(t.api.sent).toEqual(['lock']);
  });

  it('never locks a moving car or one that does not report speed', async () => {
    const moving = car([doors(false, MIN)], { speed: 12, reportedAtMs: NOW });
    (moving.controller as unknown as { autoLockState: object }).autoLockState = { attempts: 0, evidenceWakes: 0, unlockedSince: NOW - 30 * MIN };
    await moving.controller.poll();
    expect(moving.api.sent).toEqual([]);
    const unknown = car([doors(false, MIN)], { reportedAtMs: NOW });
    (unknown.controller as unknown as { autoLockState: object }).autoLockState = { attempts: 0, evidenceWakes: 0, unlockedSince: NOW - 30 * MIN };
    await unknown.controller.poll();
    expect(unknown.api.sent).toEqual([]);
  });

  it('an unlock from HomeKit during the telemetry read stops the attempt and keeps its grace', async () => {
    const t = car([doors(false, MIN)], { speed: 0, reportedAtMs: NOW });
    (t.controller as unknown as { autoLockState: object }).autoLockState = { attempts: 0, evidenceWakes: 0, unlockedSince: NOW - 30 * MIN };
    let unlocking: Promise<void> | undefined;
    t.api.readTelemetry = async () => {
      unlocking = t.controller.command('unlock');
      return { speed: 0, reportedAtMs: NOW };
    };
    await t.controller.poll();
    await unlocking;
    expect(t.api.sent).toEqual(['unlock']);
    expect(t.saved()).toMatchObject({ lastUserUnlock: NOW, attempts: 0 });
  });

  it('reads the engine state itself when Remote Start is off, and fails closed without it', async () => {
    const t = car([doors(false, MIN)], { speed: 0, reportedAtMs: NOW });
    (t.controller as unknown as { autoLockState: object }).autoLockState = { attempts: 0, evidenceWakes: 0, unlockedSince: NOW - 30 * MIN };
    t.api.running = [undefined];
    await t.controller.poll();
    expect(t.api.sent).toEqual([]);
  });

  it('an unlock from HomeKit holds auto-lock off', async () => {
    const t = car([doors(false, MIN)], { speed: 0, reportedAtMs: NOW });
    await t.controller.command('unlock');
    (t.controller as unknown as { autoLockState: { unlockedSince: number } }).autoLockState.unlockedSince = NOW - 30 * MIN;
    t.api.sent.length = 0;
    await t.controller.poll();
    expect(t.api.sent).toEqual([]);
  });
});

describe('EV charge level while charging', () => {
  const MIN = 60_000;
  const NOW = Date.parse('2026-11-27T23:17:00Z');
  function charging(evAgeMs: number, fresh?: { percent: number }) {
    const api = new FakeApi();
    api.statuses = [{ openings: [], doorsLocked: true, reportedAt: 't', reportedAtMs: NOW - MIN }];
    const stale = { batteryPercent: 7, charging: true, reportedAt: 'old', reportedAtMs: NOW - evAgeMs };
    let evReads = 0;
    api.readElectric = async () => {
      evReads++;
      return evReads === 1 || !fresh ? stale : { batteryPercent: fresh.percent, charging: true, reportedAt: 'new', reportedAtMs: NOW };
    };
    const lines: string[] = [];
    const states: VehicleState[] = [];
    let saved: number | undefined;
    const controller = new VehicleController(
      'VIN', '21MM', api,
      { remoteStart: false, exposeBattery: true, electricHint: true, evChargingRefreshMs: 30 * MIN, evWakeStore: { load: () => saved, save: (v) => { saved = v; } }, wakeWaitDelaysMs: [0, 0], now: () => NOW, sleep: async () => {} },
      { stateChanged: (s) => states.push(structuredClone(s)), commandFailed() {} },
      { info: (m) => lines.push(m), warn: (m) => lines.push(`warn:${m}`), debug() {} },
    );
    return { api, controller, lines, states, saved: () => saved };
  }

  it('asks for a fresh EV snapshot when charging and the charge report is old, and shows the new level', async () => {
    const t = charging(3 * 60 * MIN, { percent: 38 });
    expect(await t.controller.poll()).toBe('ok');
    expect(t.api.evRefreshes).toBe(1);
    expect(t.states.at(-1)?.electric?.batteryPercent).toBe(38);
    expect(t.lines[0]).toBe('Charging, and the EV battery report (7%) is 3.0 hours old; asking the vehicle for a fresh one.');
    expect(t.lines.at(-1)).toBe('The vehicle sent a fresh EV report: 38%, charging (new).');
    expect(t.saved()).toBe(NOW);
  });

  it('leaves a recent charge report alone and rations requests across restarts', async () => {
    const recent = charging(10 * MIN);
    await recent.controller.poll();
    expect(recent.api.evRefreshes).toBe(0);
    const t = charging(3 * 60 * MIN);
    await t.controller.poll();
    await t.controller.poll();
    expect(t.api.evRefreshes).toBe(1);
  });

  it('a refused EV refresh is logged and does not fail the update', async () => {
    const t = charging(3 * 60 * MIN);
    t.api.evRefreshError = new ApiHttpError(500, '');
    expect(await t.controller.poll()).toBe('ok');
    expect(t.lines.some((l) => l.startsWith('warn:Toyota refused the EV refresh'))).toBe(true);
  });

  it('a door wake also refreshes the EV snapshot', async () => {
    const api = new FakeApi();
    api.statuses = [{ openings: [], doorsLocked: true, reportedAt: 't', reportedAtMs: NOW - 5 * 60 * MIN }];
    const controller = new VehicleController('VIN', '21MM', api,
      { remoteStart: false, exposeBattery: true, electricHint: true, staleReportMs: 3 * 60 * MIN, wakeWaitDelaysMs: [0], now: () => NOW, sleep: async () => {} },
      { stateChanged() {}, commandFailed() {} }, noop);
    await controller.poll();
    expect(api.refreshes).toBe(1);
    expect(api.evRefreshes).toBe(1);
  });
});
