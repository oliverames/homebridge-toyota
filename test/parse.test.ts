import { describe, expect, it } from 'vitest';
import { parseEnvelope } from '../src/envelope';
import {
  enabledCapabilityNames,
  parseClimateRunning,
  parseElectricStatus,
  parseEngineRunning,
  parseRemoteStatus,
  parseVehicleList,
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
      ['trunk:rear-hatch', 'trunk', false, null],
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
  it('an open opening dominates an earlier lock token', () => {
    const s = status({ vehicleStatus: [{ category: 'Rear Hatch', sections: [{ section: 'Rear Hatch', values: [{ value: 'unlocked' }, { value: 'open' }] }] }] });
    expect(s.openings[0]?.open).toBe(true);
  });
  it('hatch/trunk are not counted as doors for lock state', () => {
    const s = status({ vehicleStatus: [{ category: 'Rear Hatch', sections: [{ section: 'Rear Hatch', values: [{ value: 'closed' }, { value: 'unlocked' }] }] }] });
    expect(s.doorsLocked).toBeNull();
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
