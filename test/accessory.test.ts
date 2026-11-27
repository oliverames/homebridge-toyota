import { describe, expect, it, vi } from 'vitest';
import { HomebridgeAPI } from 'homebridge/lib/api';
import type { API, Logging } from 'homebridge';
import { describeLockReport, STALE_DISPLAY_MS, VehicleAccessory } from '../src/accessory';
import type { VehicleApi, VehicleCommand } from '../src/api';
import { VehicleController } from '../src/controller';
import type { RemoteStatus, VehicleSummary } from '../src/parse';

const log = { info() {}, warn() {}, error() {}, debug() {}, log() {}, success() {} } as unknown as Logging;
const vehicle: VehicleSummary = { vin: 'TESTVIN0000000001', displayName: 'Test', modelName: 'bZ Woodland', modelYear: '2026', capabilities: [], subscriptions: [], record: {} };

const status = (locked: boolean | null, open = false): RemoteStatus => ({
  doorsLocked: locked,
  openings: [
    { key: 'door:driver-side-door', kind: 'door', label: 'Driver Side Door', open, locked },
    { key: 'trunk:rear-hatch', kind: 'trunk', label: 'Rear Hatch', open: null, locked: null },
  ],
});

function build(opts: { remoteStart?: boolean; exposeOpenings?: boolean; exposeBattery?: boolean; prepare?: boolean } = {}) {
  const api = new HomebridgeAPI() as unknown as API;
  const accessory = new api.platformAccessory('Test', api.hap.uuid.generate('x'));
  const view = new VehicleAccessory(api, log, accessory, vehicle, {
    exposeOpenings: opts.exposeOpenings ?? true,
    exposeBattery: opts.exposeBattery ?? true,
    remoteStart: opts.remoteStart ?? false,
  });
  const sent: VehicleCommand[] = [];
  let reads = [status(true)];
  const fake: VehicleApi = {
    listVehicles: async () => [],
    readStatus: async () => reads.shift() ?? status(false),
    readElectric: async () => ({}),
    readRunning: async () => true,
    sendCommand: async (c) => { sent.push(c); },
    requestRefresh: async () => {},
  };
  const controller = new VehicleController('V', '21MM', fake, { remoteStart: !!opts.remoteStart, exposeBattery: true, prepare: opts.prepare ? { closeWindows: true, closeMoonroof: true, lockTrunk: true } : undefined, verifyDelaysMs: [0], sleep: async () => {} }, view, log);
  view.attach(controller);
  return { api, accessory, view, sent, setReads: (r: RemoteStatus[]) => { reads = r; } };
}

describe('VehicleAccessory with real HAP services', () => {
  it('exposes only a lock until the vehicle reports more', () => {
    const { api, accessory } = build();
    const types = accessory.services.map((s) => s.UUID);
    expect(types).toContain(api.hap.Service.LockMechanism.UUID);
    expect(types).not.toContain(api.hap.Service.Switch.UUID);
    expect(types).not.toContain(api.hap.Service.Battery.UUID);
    expect(accessory.getService(api.hap.Service.LockMechanism)!.getCharacteristic(api.hap.Characteristic.LockCurrentState).value).toBe(3);
  });

  it('maps reported lock, openings and battery to native services', () => {
    const { api, accessory, view } = build();
    const { Service: S, Characteristic: C } = api.hap;
    view.stateChanged({ status: status(true, true), electric: { batteryPercent: 18, charging: true } });
    const lock = accessory.getService(S.LockMechanism)!;
    expect(lock.getCharacteristic(C.LockCurrentState).value).toBe(C.LockCurrentState.SECURED);
    const door = accessory.getServiceById(S.ContactSensor, 'door:driver-side-door')!;
    expect(door.getCharacteristic(C.ContactSensorState).value).toBe(C.ContactSensorState.CONTACT_NOT_DETECTED);
    // The hatch reported no position, so no sensor is invented for it.
    expect(accessory.getServiceById(S.ContactSensor, 'trunk:rear-hatch')).toBeUndefined();
    const battery = accessory.getService(S.Battery)!;
    expect(battery.getCharacteristic(C.BatteryLevel).value).toBe(18);
    expect(battery.getCharacteristic(C.StatusLowBattery).value).toBe(1);
    expect(battery.getCharacteristic(C.ChargingState).value).toBe(1);
  });

  it('reports unknown lock state honestly', () => {
    const { api, accessory, view } = build();
    view.stateChanged({ status: status(null) });
    expect(accessory.getService(api.hap.Service.LockMechanism)!.getCharacteristic(api.hap.Characteristic.LockCurrentState).value).toBe(3);
  });

  it('logs each change in the reported lock state once, with the report time and the doors behind an unknown', () => {
    const lines: string[] = [];
    const api = new HomebridgeAPI() as unknown as API;
    const accessory = new api.platformAccessory('Test', api.hap.uuid.generate('y'));
    const logging = { ...log, info: (m: string) => lines.push(m) } as unknown as Logging;
    const view = new VehicleAccessory(api, logging, accessory, vehicle, { exposeOpenings: false, exposeBattery: false, remoteStart: false });
    view.stateChanged({ status: { ...status(true), reportedAt: '2026-11-26T22:55:20Z' } });
    view.stateChanged({ status: status(true) });
    view.stateChanged({ status: status(null) });
    expect(lines[0]).toBe('The vehicle reports: Driver Side Door (closed, locked); Rear Hatch (no position, no lock value).');
    expect(lines.slice(1)).toEqual([
      'Doors reported locked (Toyota report from 2026-11-26T22:55:20Z).',
      'Doors reported unknown (Toyota gave no report time). Driver Side Door: no lock value.',
    ]);
    expect(describeLockReport({ doorsLocked: null, openings: [] })).toContain('listed no doors');
  });

  it('omits sensors and battery when disabled', () => {
    const { api, accessory, view } = build({ exposeOpenings: false, exposeBattery: false });
    view.stateChanged({ status: status(true), electric: { batteryPercent: 50 } });
    expect(accessory.getService(api.hap.Service.Battery)).toBeUndefined();
    expect(accessory.services.some((s) => s.UUID === api.hap.Service.ContactSensor.UUID)).toBe(false);
  });

  it('a lock request runs the command in the background and settles on the reported state', async () => {
    const { api, accessory, sent, setReads } = build();
    const { Service: S, Characteristic: C } = api.hap;
    const lock = accessory.getService(S.LockMechanism)!;
    setReads([status(false), status(false)]);
    const target = lock.getCharacteristic(C.LockTargetState);
    // Drive the handler the way HAP does.
    target.handleSetRequest(C.LockTargetState.UNSECURED);
    await vi.waitFor(() => expect(sent).toEqual(['unlock']));
    await vi.waitFor(() => expect(lock.getCharacteristic(C.LockCurrentState).value).toBe(C.LockCurrentState.UNSECURED));
    expect(target.value).toBe(C.LockTargetState.UNSECURED);
  });

  it('an unconfirmed command returns the target to the reported state', async () => {
    const { api, accessory, setReads } = build();
    const { Service: S, Characteristic: C } = api.hap;
    const lock = accessory.getService(S.LockMechanism)!;
    setReads([status(true)]);
    const target = lock.getCharacteristic(C.LockTargetState);
    target.handleSetRequest(C.LockTargetState.UNSECURED);
    await vi.waitFor(() => expect(target.value).toBe(C.LockTargetState.SECURED));
  });

  it('remote start switch exists only when enabled', () => {
    const on = build({ remoteStart: true });
    expect(on.accessory.getServiceById(on.api.hap.Service.Switch, 'remote-start')).toBeDefined();
    const off = build();
    expect(off.accessory.getServiceById(off.api.hap.Service.Switch, 'remote-start')).toBeUndefined();
  });

  it('a Remote Start refused because a door is open sends nothing and returns the switch to off', async () => {
    const { api, accessory, sent, setReads } = build({ remoteStart: true, prepare: true });
    const { Service: S, Characteristic: C } = api.hap;
    const power = accessory.getServiceById(S.Switch, 'remote-start')!.getCharacteristic(C.On);
    setReads([status(true, true)]);
    power.handleSetRequest(true);
    // Let the background command run its status read and abort.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(power.value).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('freshness and the hatch lock', () => {
  const NOW = Date.parse('2026-11-27T22:00:00Z');
  const withHatch = (hatch: boolean | null, ageMs = 0): RemoteStatus => ({
    doorsLocked: true,
    reportedAt: 't',
    reportedAtMs: NOW - ageMs,
    openings: [
      { key: 'door:door', kind: 'door', label: 'Door', open: false, locked: true },
      { key: 'trunk:hatch', kind: 'trunk', label: 'Hatch', open: false, locked: hatch },
    ],
  });
  function make(hatchLock: boolean) {
    const api = new HomebridgeAPI() as unknown as API;
    const accessory = new api.platformAccessory('Test', api.hap.uuid.generate(`h${hatchLock}`));
    const view = new VehicleAccessory(api, log, accessory, vehicle, { exposeOpenings: false, exposeBattery: false, remoteStart: false, hatchLock, now: () => NOW });
    const hatch = () => accessory.getServiceById(api.hap.Service.LockMechanism, 'hatch-lock');
    const doors = () => accessory.services.find((x) => x.UUID === api.hap.Service.LockMechanism.UUID && !x.subtype)!;
    return { api, view, hatch, doors };
  }

  it('shows the doors as unknown once the report is too old to trust', () => {
    const { api, view, doors } = make(false);
    view.stateChanged({ status: withHatch(null, STALE_DISPLAY_MS - 60_000) });
    expect(doors().getCharacteristic(api.hap.Characteristic.LockCurrentState).value).toBe(1);
    view.stateChanged({ status: withHatch(null, STALE_DISPLAY_MS + 60_000) });
    expect(doors().getCharacteristic(api.hap.Characteristic.LockCurrentState).value).toBe(3);
  });

  it('adds a Hatch lock only when the vehicle has the command and reports a hatch lock value', () => {
    const none = make(true);
    none.view.stateChanged({ status: withHatch(null) });
    expect(none.hatch()).toBeUndefined();
    const noCommand = make(false);
    noCommand.view.stateChanged({ status: withHatch(true) });
    expect(noCommand.hatch()).toBeUndefined();
    const { api, view, hatch } = make(true);
    view.stateChanged({ status: withHatch(false) });
    expect(hatch()!.getCharacteristic(api.hap.Characteristic.LockCurrentState).value).toBe(0);
    view.stateChanged({ status: withHatch(true) });
    expect(hatch()!.getCharacteristic(api.hap.Characteristic.LockCurrentState).value).toBe(1);
    view.stateChanged({ status: withHatch(null) });
    expect(hatch()!.getCharacteristic(api.hap.Characteristic.LockCurrentState).value).toBe(3);
  });

  it('the Hatch lock sends trunk-lock and trunk-unlock', async () => {
    const { api, view, hatch } = make(true);
    const sent: VehicleCommand[] = [];
    const controller = new VehicleController('V', '21MM', {
      listVehicles: async () => [], readElectric: async () => ({}), readRunning: async () => false, requestRefresh: async () => {},
      readStatus: async () => withHatch(sent.at(-1) === 'unlockTrunk' ? false : true),
      sendCommand: async (c) => { sent.push(c); },
    }, { remoteStart: false, exposeBattery: false, verifyDelaysMs: [0], sleep: async () => {} }, view, log);
    view.attach(controller);
    view.stateChanged({ status: withHatch(true) });
    const target = hatch()!.getCharacteristic(api.hap.Characteristic.LockTargetState);
    await target.handleSetRequest(0);
    await vi.waitFor(() => expect(sent).toEqual(['unlockTrunk']));
    await vi.waitFor(() => expect(hatch()!.getCharacteristic(api.hap.Characteristic.LockCurrentState).value).toBe(0));
  });
});
