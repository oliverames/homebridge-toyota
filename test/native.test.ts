import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomebridgeAPI } from 'homebridge/lib/api';
import type { API, Logging } from 'homebridge';
import { VehicleAccessory, JAMMED_MAX_MS } from '../src/accessory';
import { ToyotaVehicleApi } from '../src/api';
import { ToyotaAuth } from '../src/auth';
import { AUTO_LOCK, decideAutoLock, emptyAutoLockState, type AutoLockState } from '../src/autolock';
import { ApiHttpError, ToyotaClient } from '../src/client';
import { parseConfig } from '../src/config';
import { VehicleController } from '../src/controller';
import { distanceMeters, parseLocation, parseRemoteStatus, type RemoteStatus } from '../src/parse';
import { FileStore, isSession } from '../src/session';
import { ACCESS_TOKEN_URL } from '../src/settings';
import { jsonResponse, mockFetch, tokenBody } from './helpers';

const MIN = 60_000;
const NOW = Date.parse('2026-11-28T00:30:00Z');
const HOME = { latitude: 44.26, longitude: -72.575 };
const log = { info() {}, warn() {}, error() {}, debug() {}, log() {}, success() {} } as unknown as Logging;
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('vehicle location', () => {
  it('reads the position and its time from remote status, and rejects 0,0 or out-of-range values', () => {
    const status = parseRemoteStatus({ latitude: 44.26, longitude: -72.575, locationAcquisitionDatetime: '2026-11-28T00:25:15Z', vehicleStatus: [] });
    expect(status.location).toMatchObject({ latitude: 44.26, longitude: -72.575, reportedAtMs: Date.parse('2026-11-28T00:25:15Z') });
    expect(parseLocation({ latitude: 0, longitude: 0 })).toBeUndefined();
    expect(parseLocation({ latitude: 95, longitude: 10 })).toBeUndefined();
    expect(parseLocation({ payload: { latitude: '44.26', longitude: '-72.575' } })).toMatchObject({ latitude: 44.26 });
  });
  it('measures distance in metres', () => {
    expect(Math.round(distanceMeters(HOME, { latitude: 44.261, longitude: -72.575 }))).toBe(111);
  });
});

describe('auto-lock without telemetry', () => {
  const unlocked = (ageMs: number, at = HOME): RemoteStatus => ({
    doorsLocked: false, reportedAtMs: NOW - ageMs,
    location: { ...at, reportedAtMs: NOW - ageMs },
    openings: [{ key: 'door:door', kind: 'door', label: 'Door', open: false, locked: false }],
  });
  const ready = (): AutoLockState => ({ ...emptyAutoLockState(), unlockedSince: NOW - 30 * MIN, unlockedAt: HOME });
  const decide = (state: AutoLockState, status: RemoteStatus) => decideAutoLock(state, { status, running: false, now: NOW, afterMs: 10 * MIN });

  it('locks when a fresh position shows the car where it was unlocked', () => {
    expect(decide(ready(), unlocked(MIN, { latitude: 44.26002, longitude: -72.57502 }))).toEqual({ action: 'lock' });
  });
  it('does not lock a car that has moved, and starts the episode over from the new spot', () => {
    const state = ready();
    expect(decide(state, unlocked(MIN, { latitude: 44.27, longitude: -72.575 })).action).toBe('none');
    expect(state.unlockedAt).toEqual({ latitude: 44.27, longitude: -72.575 });
    expect(state.unlockedSince).toBe(NOW - MIN);
  });
  it('asks for a fresh report when the lock report is old, and needs no position when the car reports off', () => {
    expect(decide(ready(), unlocked(20 * MIN)).action).toBe('wake');
    const noPosition: RemoteStatus = { ...unlocked(MIN), location: undefined };
    expect(decide({ ...ready(), evidenceWakes: AUTO_LOCK.maxEvidenceWakes }, noPosition).action).toBe('lock');
  });
  it('records where the doors were first seen unlocked', () => {
    const state = emptyAutoLockState();
    decide(state, unlocked(MIN));
    expect(state.unlockedAt).toEqual(HOME);
  });
});

describe('optional endpoints', () => {
  it('a telemetry 403 does not force a token refresh, and the controller stops asking for 12 hours', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'toyota-native-'));
    dirs.push(dir);
    const store = new FileStore(join(dir, 'session.json'), isSession);
    store.save({ accessToken: 'a', refreshToken: 'r', idToken: 'i', expiresAt: NOW + 30 * MIN, guid: 'g', deviceId: 'd', username: 'u@example.com' });
    const net = mockFetch((url) => (url === ACCESS_TOKEN_URL ? jsonResponse(tokenBody(NOW)) : new Response('{"message":"Unauthorized"}', { status: 403 })));
    const config = parseConfig({ username: 'u@example.com', password: 'p', apiKey: 'k' }).config!;
    const client = new ToyotaClient(config, new ToyotaAuth(net.fn, undefined, () => NOW), store, net.fn, { debug() {}, info() {}, warn() {} }, () => NOW);
    await expect(new ToyotaVehicleApi(client, () => NOW).readTelemetry('JTMBGAHB5TY600213', '21MM')).rejects.toBeInstanceOf(ApiHttpError);
    expect(net.calls.filter((c) => c.url === ACCESS_TOKEN_URL)).toHaveLength(0);
  });

  it('the controller parks telemetry after a refusal', async () => {
    let telemetryReads = 0;
    const status: RemoteStatus = { doorsLocked: false, reportedAtMs: NOW - MIN, location: { ...HOME, reportedAtMs: NOW - MIN }, openings: [] };
    const controller = new VehicleController('V', '21MM', {
      listVehicles: async () => [], readStatus: async () => status, readElectric: async () => ({}), readRunning: async () => false,
      sendCommand: async () => {}, requestRefresh: async () => {}, requestElectricRefresh: async () => {},
      readTelemetry: async () => { telemetryReads++; throw new ApiHttpError(403, ''); },
    }, { remoteStart: false, exposeBattery: false, autoLock: { afterMs: 10 * MIN }, now: () => NOW, sleep: async () => {}, wakeWaitDelaysMs: [0], verifyDelaysMs: [0] },
    { stateChanged() {}, commandFailed() {} }, { info() {}, warn() {}, debug() {} });
    await controller.poll();
    await controller.poll();
    expect(telemetryReads).toBe(1);
  });
});

describe('native HomeKit touches', () => {
  function make(options: { name?: string; home?: { latitude: number; longitude: number; radiusMeters: number } } = {}, seed = 'native') {
    const api = new HomebridgeAPI() as unknown as API;
    const accessory = new api.platformAccessory('Odysseus', api.hap.uuid.generate(seed));
    const vehicle = { vin: 'JTMBGAHB5TY600213', displayName: 'Odysseus', capabilities: [], subscriptions: [], record: {} };
    const view = new VehicleAccessory(api, log, accessory, vehicle, { exposeOpenings: true, exposeBattery: false, remoteStart: false, ...options });
    const C = api.hap.Characteristic;
    const doors = () => accessory.services.find((x) => x.UUID === api.hap.Service.LockMechanism.UUID && !x.subtype)!;
    return { api, accessory, view, vehicle, C, doors };
  }
  const report = (locked: boolean, at = HOME): RemoteStatus => ({
    doorsLocked: locked, reportedAtMs: Date.now(), location: { ...at, reportedAt: 't', reportedAtMs: Date.now() },
    openings: [{ key: 'door:door', kind: 'door', label: 'Door', open: false, locked }, { key: 'window:window', kind: 'window', label: 'Window', open: false, locked: null }],
  });

  it('names tiles with the configured vehicle name and clearer labels', () => {
    const { api, accessory, view, C } = make({ name: 'Oliver’s Car' });
    view.stateChanged({ status: report(true) });
    const name = (subtype: string) => accessory.getServiceById(api.hap.Service.ContactSensor, subtype)!.getCharacteristic(C.ConfiguredName).value;
    expect(name('door:door')).toBe('Oliver’s Car Front Doors');
    expect(name('window:window')).toBe('Oliver’s Car Windows');
  });

  it('a new vehicle name renames the plugin’s own tiles but never one renamed in the Home app', () => {
    const first = make({ name: 'Odysseus' }, 'rename');
    first.view.stateChanged({ status: report(true) });
    const sensor = first.accessory.getServiceById(first.api.hap.Service.ContactSensor, 'window:window')!;
    first.doors().setCharacteristic(first.C.ConfiguredName, 'My Locks');
    const again = new VehicleAccessory(first.api, log, first.accessory, first.vehicle, { exposeOpenings: true, exposeBattery: false, remoteStart: false, name: 'Oliver’s Car' });
    again.stateChanged({ status: report(true) });
    expect(sensor.getCharacteristic(first.C.ConfiguredName).value).toBe('Oliver’s Car Windows');
    expect(first.doors().getCharacteristic(first.C.ConfiguredName).value).toBe('My Locks');
  });

  it('an At Home occupancy sensor follows the reported position', () => {
    const { api, accessory, view, C } = make({ home: { ...HOME, radiusMeters: 150 } });
    view.stateChanged({ status: report(true) });
    const sensor = accessory.getServiceById(api.hap.Service.OccupancySensor, 'at-home')!;
    expect(sensor.getCharacteristic(C.OccupancyDetected).value).toBe(C.OccupancyDetected.OCCUPANCY_DETECTED);
    view.stateChanged({ status: report(true, { latitude: 44.3, longitude: -72.6 }) });
    expect(sensor.getCharacteristic(C.OccupancyDetected).value).toBe(C.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
  });

  it('a failed lock shows Jammed until the car reports locked', () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const { view, C, doors } = make();
      view.stateChanged({ status: report(false) });
      view.commandFailed('lock', 'not confirmed by the vehicle yet');
      expect(doors().getCharacteristic(C.LockCurrentState).value).toBe(C.LockCurrentState.JAMMED);
      view.stateChanged({ status: report(false) });
      expect(doors().getCharacteristic(C.LockCurrentState).value).toBe(C.LockCurrentState.JAMMED);
      view.stateChanged({ status: report(true) });
      expect(doors().getCharacteristic(C.LockCurrentState).value).toBe(C.LockCurrentState.SECURED);
      view.commandFailed('lock', 'refused');
      vi.setSystemTime(NOW + JAMMED_MAX_MS + MIN);
      view.stateChanged({ status: report(false) });
      expect(doors().getCharacteristic(C.LockCurrentState).value).toBe(C.LockCurrentState.UNSECURED);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a busy rejection does not show Jammed', () => {
    const { view, C, doors } = make();
    view.stateChanged({ status: report(false) });
    view.commandFailed('lock', 'another command is in progress');
    expect(doors().getCharacteristic(C.LockCurrentState).value).toBe(C.LockCurrentState.UNSECURED);
  });

  it('config reads the vehicle name and validates home', () => {
    const base = { username: 'u@example.com', password: 'p', apiKey: 'k' };
    expect(parseConfig({ ...base, vehicleName: ' Oliver’s Car ' }).config?.vehicleName).toBe('Oliver’s Car');
    expect(parseConfig({ ...base, home: { latitude: 44.26, longitude: -72.575 } }).config?.home).toEqual({ latitude: 44.26, longitude: -72.575, radiusMeters: 150 });
    const bad = parseConfig({ ...base, home: { latitude: 0, longitude: 0 } });
    expect(bad.config?.home).toBeUndefined();
    expect(bad.warnings.join(' ')).toContain('"home"');
  });
});
