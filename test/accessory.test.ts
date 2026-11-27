import { describe, expect, it, vi } from 'vitest';
import { HomebridgeAPI } from 'homebridge/lib/api';
import type { API, Logging } from 'homebridge';
import { describeLockReport, VehicleAccessory } from '../src/accessory';
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
    expect(lines).toEqual([
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
