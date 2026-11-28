import { describe, expect, it } from 'vitest';
import { parseEnvelope, parseJson } from '../src/envelope';
import {
  enabledCapabilityNames,
  parseClimateRunning,
  parseElectricStatus,
  parseEngineRunning,
  parseRemoteStatus,
  reportTime,
  parseTelemetry,
  hasRemoteCapability,
  parseVehicleList,
  prepareCapabilities,
  recognizesVehicleList,
} from '../src/parse';
import { electricCharging, electricIdle, remoteStatus, vehicleList } from './fixtures';

const status = (value: unknown) => parseRemoteStatus(parseEnvelope(JSON.stringify(value)).data);

describe('vehicle list', () => {
  const vehicles = parseVehicleList(parseEnvelope(JSON.stringify(vehicleList)).data);
  it('finds vehicles and ignores a nickname equal to the VIN', () => {
    expect(vehicles.map((v) => v.vin)).toEqual(['TESTVIN0000000001', 'TESTVIN0000000002']);
    expect(vehicles[0]?.displayName).toBe('2026 bZ Woodland');
    expect(vehicles[1]?.displayName).toBe('Daily');
  });
  it('ignores a VIN that is not 17 letters and digits, since VINs also name files on disk', () => {
    expect(parseVehicleList({ payload: [{ vin: '../../etc/passwd1' }, { vin: 'JTMBGAHB5TY600213' }] }).map((v) => v.vin)).toEqual(['JTMBGAHB5TY600213']);
  });
  it('reads generation, capabilities and subscriptions', () => {
    expect(vehicles[0]?.generation).toBe('21MM');
    expect(vehicles[0]?.capabilities).toEqual(['doorLock', 'remoteStart']);
    expect(vehicles[0]?.subscriptions[0]).toEqual({ name: 'Remote Connect', status: 'ACTIVE', daysRemaining: 120 });
    expect(vehicles[1]?.generation).toBeUndefined();
  });
  it('recognizes list shapes and rejects others', () => {
    expect(recognizesVehicleList(vehicleList.payload)).toBe(true);
    expect(recognizesVehicleList([])).toBe(true);
    expect(recognizesVehicleList({ hello: 'world' })).toBe(false);
  });
  it('treats string capability flags and objects per RedLink rules', () => {
    expect(enabledCapabilityNames({ remoteServiceCapabilities: { a: 'enabled', b: 'no', c: { enabled: false }, d: 1 } })).toEqual(['a', 'd']);
  });
});

describe('remote status', () => {
  it('reads each opening with position and lock separately', () => {
    const s = status(remoteStatus());
    expect(s.openings.map((o) => [o.key, o.kind, o.open, o.locked])).toEqual([
      ['door:driver-side-door', 'door', false, true],
      ['door:passenger-side-door', 'door', false, true],
      ['trunk:rear-hatch', 'trunk', false, true],
      ['window:driver-side-window', 'window', false, null],
      ['hood:hood', 'hood', false, null],
    ]);
    expect(s.doorsLocked).toBe(true);
  });
  it('one unlocked door makes the vehicle unlocked', () => {
    expect(status(remoteStatus({ driverLocked: false })).doorsLocked).toBe(false);
  });
  it('a closed door is not a locked door', () => {
    const s = status({ vehicleStatus: [{ category: 'Driver Side Door', sections: [{ section: 'Driver Side Door', values: [{ value: 'closed' }] }] }] });
    expect(s.doorsLocked).toBeNull();
    expect(s.openings[0]?.open).toBe(false);
  });
  it('a locked door beside a position-only door is unknown, not secured', () => {
    const s = status({
      vehicleStatus: [
        { category: 'Driver Side Door', sections: [{ section: 'Driver Side Door', values: [{ value: 'closed' }, { value: 'locked' }] }] },
        { category: 'Passenger Side Door', sections: [{ section: 'Passenger Side Door', values: [{ value: 'closed' }] }] },
      ],
    });
    expect(s.doorsLocked).toBeNull();
  });
  it('keeps the time the vehicle uploaded the report, when Toyota gives one', () => {
    const doors = [{ category: 'Driver Side Door', sections: [{ section: 'Driver Side Door', values: [{ value: 'locked' }] }] }];
    expect(status({ payload: { occurrenceDate: '2026-11-26T22:55:20Z', vehicleStatus: doors } }).reportedAt).toBe('2026-11-26T22:55:20Z');
    expect(status({ payload: { occurrenceDate: '2026-11-26T22:55:20Z', vehicleStatus: doors } }).reportedAtMs).toBe(Date.parse('2026-11-26T22:55:20Z'));
    expect(status({ vehicleStatus: doors }).reportedAt).toBeUndefined();
  });
  it('reads telemetry speed with its report time, from the paths RedLink reads', () => {
    const now = Date.parse('2026-11-27T22:00:00Z');
    expect(parseTelemetry({ payload: { speed: { value: 0, unit: 'mph' }, lastTimestamp: '2026-11-27T21:58:00Z' } }, now)).toEqual({ speed: 0, reportedAt: '2026-11-27T21:58:00Z', reportedAtMs: Date.parse('2026-11-27T21:58:00Z') });
    expect(parseTelemetry({ vehicleSpeed: '12.5' }, now)).toEqual({ speed: 12.5 });
    expect(parseTelemetry({ payload: { speed: -1 } }, now)).toEqual({});
    expect(parseTelemetry(null, now)).toEqual({});
  });
  it('a non-JSON body becomes a fixed message that does not quote the body', () => {
    expect(() => parseJson('<html>secret-ish page</html>')).toThrow('not JSON (28 bytes)');
    expect(() => parseEnvelope('<html>secret-ish page</html>')).not.toThrow(/secret/);
  });
  it('reads the EV snapshot time from vehicleInfo.acquisitionDatetime', () => {
    const now = Date.parse('2026-11-27T23:00:00Z');
    const ev = parseElectricStatus({ payload: { vehicleInfo: { acquisitionDatetime: '2026-11-27T17:42:10Z', chargeInfo: { chargeRemainingAmount: 7 } } } }, now);
    expect(ev).toMatchObject({ batteryPercent: 7, reportedAt: '2026-11-27T17:42:10Z', reportedAtMs: Date.parse('2026-11-27T17:42:10Z') });
  });
  it('reads epoch report times and rejects implausible ones', () => {
    const now = Date.parse('2026-11-27T20:00:00Z');
    expect(reportTime({ lastTimestamp: 1_764_270_000 }, now).reportedAtMs).toBe(1_764_270_000_000);
    expect(reportTime({ occurrenceDate: 1_764_270_000_000 }, now).reportedAtMs).toBe(1_764_270_000_000);
    expect(reportTime({ occurrenceDate: 12 }, now).reportedAtMs).toBeUndefined();
    expect(reportTime({ occurrenceDate: '2027-06-01T00:00:00Z' }, now).reportedAtMs).toBeUndefined();
    expect(reportTime({ timestamp: '2026-11-27T19:59:00Z' }, now)).toEqual({});
  });
  it('an open opening dominates an earlier lock token', () => {
    const s = status({ vehicleStatus: [{ category: 'Rear Hatch', sections: [{ section: 'Rear Hatch', values: [{ value: 'unlocked' }, { value: 'open' }] }] }] });
    expect(s.openings[0]?.open).toBe(true);
  });
  it('hatch/trunk are not counted as doors for lock state, but their own lock token is read', () => {
    const s = status({ vehicleStatus: [{ category: 'Rear Hatch', sections: [{ section: 'Rear Hatch', values: [{ value: 'closed' }, { value: 'unlocked' }] }] }] });
    expect(s.doorsLocked).toBeNull();
    expect(s.openings[0]).toMatchObject({ kind: 'trunk', open: false, locked: false });
  });
  it('empty and unrecognized payloads report nothing', () => {
    expect(status({})).toEqual({ openings: [], doorsLocked: null });
    expect(parseRemoteStatus(undefined)).toEqual({ openings: [], doorsLocked: null });
  });
});

describe('electric status', () => {
  const electric = (v: unknown) => parseElectricStatus(parseEnvelope(JSON.stringify(v)).data);
  it('reads charge percent and infers charging from remaining time for numeric codes', () => {
    expect(electric(electricCharging)).toEqual({ batteryPercent: 64, charging: true });
    expect(electric(electricIdle)).toEqual({ batteryPercent: 18, charging: false });
  });
  it('understands named connector states', () => {
    const named = (s: string) => electric({ payload: { vehicleInfo: { chargeInfo: { chargeRemainingAmount: 50, connectorStatus: s } } } });
    expect(named('CHARGING').charging).toBe(true);
    expect(named('NOT_CHARGING').charging).toBe(false);
    expect(named('CHARGE_COMPLETE').charging).toBe(false);
  });
  it('rejects out-of-range percentages and missing data', () => {
    expect(electric({ payload: { vehicleInfo: { chargeInfo: { chargeRemainingAmount: 140 } } } }).batteryPercent).toBeUndefined();
    expect(electric({})).toEqual({});
  });
});

describe('engine and climate', () => {
  it('reads running flags', () => {
    expect(parseEngineRunning({ running: true })).toBe(true);
    expect(parseEngineRunning({ status: '0' })).toBe(false);
    expect(parseEngineRunning({})).toBeUndefined();
    expect(parseClimateRunning({ isRunning: false })).toBe(false);
    expect(parseClimateRunning({})).toBeUndefined();
  });
});

describe('remote capability matching', () => {
  it('matches long-form names on word boundaries, as RedLink does', () => {
    expect(hasRemoteCapability(['moonRoofCapable'], 'sunroof', 'moonroof')).toBe(true);
    expect(hasRemoteCapability(['trunkLockUnlockCapable'], 'trunk', 'hatch')).toBe(true);
    expect(hasRemoteCapability(['powerWindowCapable'], 'window')).toBe(true);
    expect(hasRemoteCapability(['windowsomething'], 'window')).toBe(false);
  });
  it('treats a negated name and a missing name as unsupported', () => {
    expect(hasRemoteCapability(['noMoonroof'], 'moonroof')).toBe(false);
    expect(hasRemoteCapability(['doorLock'], 'window')).toBe(false);
    expect(hasRemoteCapability([], 'window')).toBe(false);
  });
  it('gates the preparation commands on capabilities, generation and the bZ moonroof rule', () => {
    const vehicle = { capabilities: ['powerWindowCapable', 'moonRoofCapable', 'trunkLockUnlockCapable'], modelName: 'Camry', nickname: undefined };
    expect(prepareCapabilities(vehicle, '21MM')).toEqual({ closeWindows: true, closeMoonroof: true, lockTrunk: true });
    expect(prepareCapabilities(vehicle, '17CY')).toEqual({ closeWindows: false, closeMoonroof: false, lockTrunk: false });
    expect(prepareCapabilities({ ...vehicle, modelName: 'bZ Woodland' }, '21MM').closeMoonroof).toBe(false);
    expect(prepareCapabilities({ capabilities: ['doorLock'], modelName: 'Camry', nickname: undefined }, '21MM')).toEqual({
      closeWindows: false,
      closeMoonroof: false,
      lockTrunk: false,
    });
  });
});
