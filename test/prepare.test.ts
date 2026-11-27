import { describe, expect, it } from 'vitest';
import type { VehicleApi, VehicleCommand } from '../src/api';
import { ApiHttpError } from '../src/client';
import { type ControllerListener, VehicleController } from '../src/controller';
import type { ElectricStatus, Opening, OpeningKind, PrepareCapabilities, RemoteStatus } from '../src/parse';

const all: PrepareCapabilities = { closeWindows: true, closeMoonroof: true, lockTrunk: true };
const none: PrepareCapabilities = { closeWindows: false, closeMoonroof: false, lockTrunk: false };

function opening(kind: OpeningKind, label: string, open: boolean | null, locked: boolean | null = null): Opening {
  return { key: `${kind}:${label.toLowerCase().replace(/ /g, '-')}`, kind, label, open, locked };
}

interface CarState {
  doorLocked: boolean;
  doorOpen: boolean;
  windowOpen: boolean;
  roofOpen: boolean;
  hatchOpen: boolean;
  hatchLocked: boolean;
  hoodOpen: boolean;
}

const parked: CarState = { doorLocked: true, doorOpen: false, windowOpen: false, roofOpen: false, hatchOpen: false, hatchLocked: true, hoodOpen: false };

/** A car whose state changes only when a command it accepts takes effect. */
class FakeCar implements VehicleApi {
  sent: VehicleCommand[] = [];
  statusReads = 0;
  runningReads = 0;
  refuse = new Map<VehicleCommand, Error>();
  /** Commands Toyota accepts but the vehicle never acts on. */
  ignore = new Set<VehicleCommand>();
  readError?: Error;
  /** Throws from the Nth status read (1-based) onward. */
  failReadsFrom?: { n: number; error: Error };
  /** Status reads (1-based) that answer a transient 503. */
  failReads?: Set<number>;
  running = false;
  constructor(public car: CarState) {}

  listVehicles = async () => [];
  readElectric = async (): Promise<ElectricStatus> => ({});
  requestRefresh = async (): Promise<void> => {};
  readTelemetry = async () => ({});
  async readStatus(): Promise<RemoteStatus> {
    this.statusReads++;
    if (this.readError) throw this.readError;
    if (this.failReadsFrom && this.statusReads >= this.failReadsFrom.n) throw this.failReadsFrom.error;
    if (this.failReads?.has(this.statusReads)) throw new ApiHttpError(503, '');
    const c = this.car;
    return {
      doorsLocked: c.doorLocked,
      openings: [
        opening('door', 'Driver Side Door', c.doorOpen, c.doorLocked),
        opening('window', 'Driver Side Window', c.windowOpen),
        opening('roof', 'Moonroof', c.roofOpen),
        opening('trunk', 'Rear Hatch', c.hatchOpen, c.hatchLocked),
        opening('hood', 'Hood', c.hoodOpen),
      ],
    };
  }
  async readRunning(): Promise<boolean | undefined> {
    this.runningReads++;
    return this.running;
  }
  async sendCommand(command: VehicleCommand): Promise<void> {
    const error = this.refuse.get(command);
    if (error) throw error;
    this.sent.push(command);
    if (this.ignore.has(command)) return;
    switch (command) {
      case 'lock': this.car.doorLocked = true; break;
      case 'closeWindows': this.car.windowOpen = false; break;
      case 'closeMoonroof': this.car.roofOpen = false; break;
      case 'lockTrunk': this.car.hatchLocked = true; break;
      case 'remoteStart': this.running = true; break;
      default: break;
    }
  }
}

function setup(car: FakeCar, prepare: PrepareCapabilities | null = all) {
  const failures: string[] = [];
  const warnings: string[] = [];
  const sleeps: number[] = [];
  const listener: ControllerListener = {
    stateChanged: () => {},
    commandFailed: (c, reason) => failures.push(`${c}:${reason}`),
  };
  const log = { info() {}, debug() {}, warn: (m: string) => warnings.push(m) };
  const controller = new VehicleController('VIN', '21MM', car, { remoteStart: true, exposeBattery: false, prepare: prepare ?? undefined, sleep: async (ms) => { sleeps.push(ms); } }, listener, log);
  return { controller, failures, warnings, sleeps };
}

describe('Remote Start preparation', () => {
  it('starts straight away when the car is already locked and closed, after one status read', async () => {
    const car = new FakeCar({ ...parked });
    const { controller, failures } = setup(car);
    await controller.command('remoteStart');
    expect(car.sent).toEqual(['remoteStart']);
    expect(car.statusReads).toBe(1);
    expect(failures).toEqual([]);
  });

  it('locks an unlocked car, confirms from status, then starts', async () => {
    const car = new FakeCar({ ...parked, doorLocked: false });
    const { controller, failures, sleeps } = setup(car);
    await controller.command('remoteStart');
    expect(car.sent).toEqual(['lock', 'remoteStart']);
    expect(failures).toEqual([]);
    // One confirming read at the usual 10 second cadence for the lock, then one for the start.
    expect(sleeps).toEqual([10_000, 10_000]);
    expect(car.statusReads).toBe(2);
  });

  it('closes an open window when the vehicle supports it, and starts', async () => {
    const car = new FakeCar({ ...parked, windowOpen: true });
    const { controller, failures } = setup(car);
    await controller.command('remoteStart');
    expect(car.sent).toEqual(['closeWindows', 'remoteStart']);
    expect(failures).toEqual([]);
  });

  it('leaves an open window alone, says so, and still starts when the vehicle cannot close it', async () => {
    const car = new FakeCar({ ...parked, windowOpen: true });
    const { controller, failures, warnings } = setup(car, none);
    await controller.command('remoteStart');
    expect(car.sent).toEqual(['remoteStart']);
    expect(failures).toEqual([]);
    expect(warnings.some((w) => w.includes('close the windows'))).toBe(true);
  });

  it('runs every step in order: doors, windows, moonroof, hatch, then the start', async () => {
    const car = new FakeCar({ ...parked, doorLocked: false, windowOpen: true, roofOpen: true, hatchLocked: false });
    const { controller, failures } = setup(car);
    await controller.command('remoteStart');
    expect(car.sent).toEqual(['lock', 'closeWindows', 'closeMoonroof', 'lockTrunk', 'remoteStart']);
    expect(failures).toEqual([]);
  });

  it('skips the moonroof and hatch steps without the capability but still locks the doors', async () => {
    const car = new FakeCar({ ...parked, doorLocked: false, roofOpen: true, hatchLocked: false });
    const { controller } = setup(car, { closeWindows: true, closeMoonroof: false, lockTrunk: false });
    await controller.command('remoteStart');
    expect(car.sent).toEqual(['lock', 'remoteStart']);
  });

  it.each([
    ['a door', { doorOpen: true }, 'Driver Side Door is open'],
    ['the hood', { hoodOpen: true }, 'Hood is open'],
    ['the hatch', { hatchOpen: true }, 'Rear Hatch is open'],
  ])('refuses to start with %s physically open and sends nothing', async (_name, patch, reason) => {
    const car = new FakeCar({ ...parked, doorLocked: false, ...patch });
    const { controller, failures } = setup(car);
    await controller.command('remoteStart');
    expect(car.sent).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(reason);
    expect(controller.commandPending).toBe(false);
  });

  it('aborts when a preparation step is refused, and never starts', async () => {
    const car = new FakeCar({ ...parked, doorLocked: false });
    car.refuse.set('lock', new ApiHttpError(400, '{"message":"Key detected inside the vehicle"}'));
    const { controller, failures } = setup(car);
    await controller.command('remoteStart');
    expect(car.sent).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('could not lock the doors first');
    expect(failures[0]).toContain('Key detected inside the vehicle');
  });

  it('aborts when a step is accepted but does not take effect within the minute of confirmation reads', async () => {
    const car = new FakeCar({ ...parked, windowOpen: true });
    car.ignore.add('closeWindows');
    const { controller, failures, sleeps } = setup(car);
    await controller.command('remoteStart');
    expect(car.sent).toEqual(['closeWindows']);
    expect(sleeps).toEqual(Array(6).fill(10_000));
    expect(car.statusReads).toBe(1 + 6);
    expect(failures[0]).toContain('could not close the windows first (not confirmed by the vehicle yet)');
  });

  it('stops reading when Toyota rate limits a confirmation read instead of hammering it', async () => {
    const car = new FakeCar({ ...parked, doorLocked: false });
    car.failReadsFrom = { n: 2, error: new ApiHttpError(429, '') };
    const { controller, failures } = setup(car);
    await controller.command('remoteStart');
    expect(car.sent).toEqual(['lock']);
    expect(car.statusReads).toBe(2);
    expect(failures[0]).toContain('429');
  });

  it('aborts when the first status read fails twice', async () => {
    const car = new FakeCar({ ...parked });
    car.readError = new ApiHttpError(503, '');
    const { controller, failures } = setup(car);
    await controller.command('remoteStart');
    expect(car.sent).toEqual([]);
    expect(car.statusReads).toBe(2);
    expect(failures[0]).toContain('could not read the vehicle status first');
  });

  it('retries a transient first status read once, then starts', async () => {
    const car = new FakeCar({ ...parked });
    car.failReads = new Set([1]);
    const { controller, failures, sleeps } = setup(car);
    await controller.command('remoteStart');
    expect(car.sent).toEqual(['remoteStart']);
    expect(sleeps[0]).toBe(5_000);
    expect(failures).toEqual([]);
  });

  it('does not retry the first status read on a rate limit', async () => {
    const car = new FakeCar({ ...parked });
    car.readError = new ApiHttpError(429, '');
    const { controller } = setup(car);
    await controller.command('remoteStart');
    expect(car.statusReads).toBe(1);
  });

  // 2026-11-17: the lock was accepted but a 21MM bZ took longer than 30 s to report it, so the start was never sent.
  it('waits through a slow lock report and a 503 while confirming, then starts', async () => {
    const car = new FakeCar({ ...parked, doorLocked: false });
    car.ignore.add('lock');
    car.failReads = new Set([3]);
    const { controller, failures } = setup(car);
    const command = controller.command('remoteStart');
    // The car reports the lock only on the fifth status read (about 40 seconds in).
    const read = car.readStatus.bind(car);
    car.readStatus = async () => {
      if (car.statusReads === 4) car.car.doorLocked = true;
      return read();
    };
    await command;
    expect(car.sent).toEqual(['lock', 'remoteStart']);
    expect(failures).toEqual([]);
  });

  it('does nothing extra when preparation is turned off', async () => {
    const car = new FakeCar({ ...parked, doorLocked: false, windowOpen: true });
    const { controller } = setup(car, null);
    await controller.command('remoteStart');
    expect(car.sent).toEqual(['remoteStart']);
    expect(car.statusReads).toBe(0);
  });

  it('does not prepare before Remote Stop', async () => {
    const car = new FakeCar({ ...parked, doorLocked: false });
    car.running = true;
    const { controller } = setup(car);
    await controller.command('remoteStop');
    expect(car.sent).toEqual(['remoteStop']);
    expect(car.statusReads).toBe(0);
  });
});
