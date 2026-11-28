import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomebridgeAPI } from 'homebridge/lib/api';
import type { API, Logging } from 'homebridge';
import { ToyotaVehicleApi } from '../src/api';
import { ToyotaAuth } from '../src/auth';
import { describeSession, networkReason, ToyotaClient } from '../src/client';
import { parseConfig } from '../src/config';
import { VehicleAccessory } from '../src/accessory';
import { VehicleController } from '../src/controller';
import { describeSettings, verboseLogger } from '../src/platform';
import { FileStore, isSession, type Session } from '../src/session';
import { ACCESS_TOKEN_URL } from '../src/settings';
import { jsonResponse, makeJwt, mockFetch, tokenBody } from './helpers';

const NOW = 1_800_000_000_000;
const PASSWORD = 'pw-secret-value-9';
const KEY = 'ckey0123456789abcdefghijklmnopqrstuvwx';
const VIN = 'JTMBGAHB5TY600213';
const OLD_ACCESS = 'old-access-token-value';
const OLD_REFRESH = 'old-refresh-token-value';
const GUID = 'guid-secret-1234';
const DEVICE = 'device-secret-5678';
const config = parseConfig({ username: 'driver@example.com', password: PASSWORD, apiKey: KEY }).config!;
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('logging never leaks secrets', () => {
  it('a refresh, reads, a command and a refused request log timing and outcomes but no secret, token or full VIN', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'toyota-log-'));
    dirs.push(dir);
    const store = new FileStore(join(dir, 'session.json'), isSession);
    // Expired access token, so the first request refreshes.
    store.save({ accessToken: OLD_ACCESS, refreshToken: OLD_REFRESH, idToken: 'id', expiresAt: NOW - 1, guid: GUID, deviceId: DEVICE, username: 'driver@example.com' });
    const refreshJwt = makeJwt({ exp: Math.floor(NOW / 1000) + 90 * 86400 });
    let reads = 0;
    const net = mockFetch((url) => {
      if (url === ACCESS_TOKEN_URL) return jsonResponse(tokenBody(NOW, { refresh_token: refreshJwt, expires_in: 1800 }));
      reads++;
      if (reads === 3) return new Response(`{"message":"refused for ${VIN} with ${KEY}"}`, { status: 500 });
      return jsonResponse({ status: 'SUCCESS', payload: { occurrenceDate: '2026-11-27T22:50:41Z', vehicleStatus: [] } });
    });
    const lines: string[] = [];
    const log = { debug: (m: string) => lines.push(m), info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) };
    const client = new ToyotaClient(config, new ToyotaAuth(net.fn, undefined, () => NOW), store, net.fn, log, () => NOW);
    const api = new ToyotaVehicleApi(client, () => NOW);
    await api.readStatus(VIN, '21MM');
    await api.sendCommand('lock', VIN, '21MM', false);
    const refused = await api.readStatus(VIN, '21MM').catch((e: unknown) => e);
    // The error message reaches the warning log through the platform, so it must be clean too.
    lines.push(String(refused instanceof Error ? refused.message : refused));
    expect(lines.at(-1)).toContain('…0213');

    expect(lines.some((l) => /^Toyota token refreshed in \d+ ms; access token valid 30 min, sign-in valid 90 days\.$/.test(l))).toBe(true);
    expect(lines.some((l) => /^GET v1\/global\/remote\/status answered HTTP 200 in \d+ ms$/.test(l))).toBe(true);
    expect(lines.some((l) => /^POST v1\/global\/remote\/command answered HTTP 200 in \d+ ms$/.test(l))).toBe(true);
    expect(lines.some((l) => /^GET v1\/global\/remote\/status answered HTTP 500/.test(l))).toBe(true);
    const all = lines.join('\n');
    for (const secret of [PASSWORD, KEY, OLD_ACCESS, OLD_REFRESH, refreshJwt, 'access-A', GUID, DEVICE, VIN]) {
      expect(all, secret).not.toContain(secret);
    }
  });

  it('describes sessions and network failures by time and kind only', () => {
    const session: Session = { accessToken: 'a', refreshToken: makeJwt({ exp: Math.floor(NOW / 1000) + 10 * 86400 }), idToken: 'i', expiresAt: NOW + 29 * 60_000, guid: 'g', deviceId: 'd', username: 'u' };
    expect(describeSession(session, NOW)).toBe('access token valid 29 min, sign-in valid 10 days');
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    expect(networkReason(timeout)).toBe('timed out');
    expect(networkReason(Object.assign(new TypeError('fetch failed https://x/?vin=SECRET'), { cause: { code: 'ENOTFOUND' } }))).toBe('TypeError (ENOTFOUND)');
  });

  it('the startup summary lists the settings in effect and none of the credentials', () => {
    const c = parseConfig({ username: 'driver@example.com', password: PASSWORD, apiKey: KEY, vin: VIN, autoLock: { enabled: true }, remoteStart: { enabled: true }, debug: true }).config!;
    const line = describeSettings(c);
    expect(line).toContain('auto-lock after 10 min');
    expect(line).toContain('Remote Start on with preparation');
    expect(line).toContain('one vehicle (…0213)');
    expect(line).toContain('debug logging on');
    for (const secret of [PASSWORD, KEY, VIN, 'driver@example.com']) {
      expect(line, secret).not.toContain(secret);
    }
  });

  it('the debug setting shows debug lines at info level, marked', () => {
    const info = vi.fn();
    const debug = vi.fn();
    const base = Object.assign(() => {}, { info, debug, warn: vi.fn(), error: vi.fn(), log: vi.fn(), success: vi.fn() }) as unknown as Logging;
    const log = verboseLogger(base);
    log.debug('a detail');
    log.info('normal');
    expect(info).toHaveBeenCalledWith('[debug] a detail');
    expect(info).toHaveBeenCalledWith('normal');
    expect(debug).not.toHaveBeenCalled();
  });
});

describe('HomeKit and vehicle events are logged', () => {
  it('logs what HomeKit asked for, and each open, close, charging and engine change once', async () => {
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error() {}, debug() {}, log() {}, success() {} } as unknown as Logging;
    const api = new HomebridgeAPI() as unknown as API;
    const accessory = new api.platformAccessory('Odysseus', api.hap.uuid.generate('logs'));
    const vehicle = { vin: VIN, displayName: 'Odysseus', capabilities: [], subscriptions: [], record: {} };
    const view = new VehicleAccessory(api, log, accessory, vehicle, { exposeOpenings: true, exposeBattery: true, remoteStart: true });
    const status = (open: boolean) => ({
      doorsLocked: true as const, reportedAt: '2026-11-27T22:50:41Z', reportedAtMs: Date.now(),
      openings: [{ key: 'trunk:hatch', kind: 'trunk' as const, label: 'Hatch', open, locked: true }],
    });
    const controller = new VehicleController('V', '21MM', {
      listVehicles: async () => [], readStatus: async () => status(false), readElectric: async () => ({}), readRunning: async () => false,
      sendCommand: async () => {}, requestRefresh: async () => {}, requestElectricRefresh: async () => {}, readTelemetry: async () => ({}),
    }, { remoteStart: false, exposeBattery: false, verifyDelaysMs: [0], sleep: async () => {} }, view, log as never);
    view.attach(controller);

    view.stateChanged({ status: status(false), electric: { batteryPercent: 70, charging: false }, running: false });
    view.stateChanged({ status: status(true), electric: { batteryPercent: 71, charging: true }, running: true });
    view.stateChanged({ status: status(true), electric: { batteryPercent: 72, charging: true }, running: true });
    const doors = accessory.services.find((s) => s.UUID === api.hap.Service.LockMechanism.UUID && !s.subtype)!;
    await doors.getCharacteristic(api.hap.Characteristic.LockTargetState).handleSetRequest(1);

    expect(lines.filter((l) => l === 'Hatch reported open (2026-11-27T22:50:41Z).')).toHaveLength(1);
    expect(lines.filter((l) => l === 'EV battery started charging at 71%.')).toHaveLength(1);
    expect(lines.filter((l) => l === 'The vehicle reports the engine or climate running.')).toHaveLength(1);
    expect(lines).toContain('HomeKit asked to lock the doors.');
  });
});
