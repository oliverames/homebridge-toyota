import { describe, expect, it } from 'vitest';
import type { VehicleApi, VehicleCommand } from '../src/api';
import { OtpRequiredError } from '../src/auth';
import { ApiHttpError, ClientKeyRejectedError } from '../src/client';
import { type ControllerListener, VehicleController, type VehicleState } from '../src/controller';
import type { ElectricStatus, RemoteStatus } from '../src/parse';

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

  it('a rotated client key on the EV endpoint is parked too, while status still reports the key problem', async () => {
    const api = new FakeApi();
    api.electric = new ClientKeyRejectedError();
    expect(await setup(api).controller.poll()).toBe('ok');
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

  it('polls at most three times, then tells HomeKit to fall back to the reported state', async () => {
    const api = new FakeApi();
    api.statuses = [locked];
    const { controller, events, sleeps } = setup(api);
    await controller.command('unlock');
    expect(sleeps).toEqual([10_000, 10_000, 10_000]);
    expect(api.statusReads).toBe(3);
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
