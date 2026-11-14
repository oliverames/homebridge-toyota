import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToyotaVehicleApi } from '../src/api';
import { ToyotaAuth } from '../src/auth';
import { ApiHttpError, refusalReason, ToyotaClient } from '../src/client';
import { parseConfig } from '../src/config';
import { VehicleController } from '../src/controller';
import { redact } from '../src/redact';
import { FileStore, isSession, type Session } from '../src/session';
import { mockFetch } from './helpers';

const NOW = 1_800_000_000_000;
const KEY = 'test-client-key-not-real';
const config = parseConfig({ username: 'driver@example.com', password: 'pw', apiKey: KEY }).config!;
const session: Session = { accessToken: 'access-token-value', refreshToken: 'rt', idToken: 'id', expiresAt: NOW + 3_600_000, guid: 'guid-1', deviceId: 'device-abc', username: 'driver@example.com' };
const VIN = 'TESTVIN0000000001';
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function build(handler: Parameters<typeof mockFetch>[0], logs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'toyota-cmd-'));
  dirs.push(dir);
  const store = new FileStore(join(dir, 'session.json'), isSession);
  store.save(session);
  const net = mockFetch(handler);
  const log = { debug: (m: string) => logs.push(`debug: ${m}`), info: (m: string) => logs.push(`info: ${m}`), warn: (m: string) => logs.push(`warn: ${m}`) };
  const client = new ToyotaClient(config, new ToyotaAuth(net.fn, undefined, () => NOW), store, net.fn, log, () => NOW);
  return { api: new ToyotaVehicleApi(client, () => NOW), net, log, logs };
}

describe('startClimate request (issue #3: pinned against RedLink ToyotaRequestFactory)', () => {
  it('sends exactly the URL, method, headers and body RedLink sends for climate-on', async () => {
    const { api, net } = build(() => new Response('{"status":"SUCCESS","payload":{}}', { status: 200 }));
    await api.sendCommand('remoteStart', VIN, '21MM', true);
    expect(net.calls).toHaveLength(1);
    const { url, init } = net.calls[0]!;
    expect(url).toBe('https://onecdn.telematicsct.com/oneapi/v2/electric/command');
    expect(init?.method).toBe('POST');
    // Byte-for-byte what JSONSerialization(.sortedKeys) writes for RedLink's body; 68.0 serializes as 68.
    expect(init?.body).toBe('{"command":"startClimate","remoteHvac":{"settingType":"AUTO","temperature":68,"temperatureUnit":"F"}}');
    const headers = init?.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(
      [
        'accept', 'authorization', 'content-type', 'device-id', 'generation', 'user-agent', 'vin', 'x-api-key', 'x-appbrand', 'x-appversion',
        'x-brand', 'x-channel', 'x-correlationid', 'x-device-timezone', 'x-generation', 'x-guid', 'x-locale', 'x-osname', 'x-osversion', 'x-region', 'x-vin',
      ].sort(),
    );
    expect(headers).toMatchObject({
      authorization: 'Bearer access-token-value',
      'x-api-key': KEY,
      'x-guid': 'guid-1',
      'device-id': 'device-abc',
      'content-type': 'application/json',
      accept: 'application/json',
      vin: VIN,
      'x-vin': VIN,
      'x-generation': '21MM',
      generation: '21MM',
      'x-brand': 'T',
      'x-appbrand': 'T',
      'x-channel': 'ONEAPP',
      'x-region': 'US',
      'x-locale': 'en-US',
      'x-osname': 'iOS',
    });
    // RedLink sends UUID().uuidString, which is uppercase.
    expect(headers['x-correlationid']).toMatch(/^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/);
  });

  it('stopClimate keeps the same route and headers with the bare body', async () => {
    const { api, net } = build(() => new Response('{"status":"SUCCESS"}', { status: 200 }));
    await api.sendCommand('remoteStop', VIN, '21MM', true);
    expect(net.calls[0]?.init?.body).toBe('{"command":"stopClimate"}');
    expect((net.calls[0]?.init?.headers as Record<string, string>)['device-id']).toBe('device-abc');
  });

  it('sends the window, moonroof and hatch preparation commands on the shared remote command route', async () => {
    const { api, net } = build(() => new Response('{"status":"SUCCESS"}', { status: 200 }));
    await api.sendCommand('closeWindows', VIN, '21MM', true);
    await api.sendCommand('closeMoonroof', VIN, '21MM', true);
    await api.sendCommand('lockTrunk', VIN, '21MM', true);
    expect(net.calls.map((c) => c.url)).toEqual(Array(3).fill('https://onecdn.telematicsct.com/oneapi/v1/global/remote/command'));
    expect(net.calls.map((c) => c.init?.body)).toEqual([
      '{"command":"power-window-close","autoFixPopup":false}',
      '{"command":"sunroof-close","autoFixPopup":false}',
      '{"command":"trunk-lock","autoFixPopup":false}',
    ]);
  });

  it('refuses window, moonroof and hatch commands on 17CY, as RedLink does', async () => {
    const { api, net } = build(() => new Response('{}', { status: 200 }));
    await expect(api.sendCommand('closeWindows', VIN, '17CY', false)).rejects.toThrow(/not available on 17CY/);
    expect(net.calls).toHaveLength(0);
  });

  it('logs the outgoing command shape at debug level without any token', async () => {
    const { api, logs } = build(() => new Response('{"status":"SUCCESS"}', { status: 200 }));
    await api.sendCommand('remoteStart', VIN, '21MM', true);
    const line = logs.find((l) => l.includes('POST v2/electric/command'));
    expect(line).toContain('device-id');
    expect(line).toContain('"temperature":68');
    expect(line).not.toContain('access-token-value');
    expect(line).not.toContain(KEY);
  });
});

describe("refusal reason from Toyota's body", () => {
  it('puts the reason from an HTTP 400 body in the error, with token-like text removed', async () => {
    const body = JSON.stringify({ status: 'ERROR', message: 'Remote climate refused: a door is open. Bearer abcdef0123456789abcdef0123456789 for TESTVIN0000000001' });
    const { api } = build(() => new Response(body, { status: 400 }));
    const error = await api.sendCommand('remoteStart', VIN, '21MM', true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiHttpError);
    const message = (error as Error).message;
    expect(message).toContain('HTTP 400');
    expect(message).toContain('Remote climate refused: a door is open.');
    expect(message).not.toContain('abcdef0123456789');
    expect(message).not.toContain(VIN);
  });

  it('reaches the log through the controller when a command is refused', async () => {
    const body = JSON.stringify({ errors: [{ message: 'Vehicle not ready; token=eyJhbGciOi.eyJzdWIiOiIx.c2ln' }] });
    const logs: string[] = [];
    const { api, log } = build(() => new Response(body, { status: 400 }), logs);
    const failed: string[] = [];
    const controller = new VehicleController('VIN', '21MM', api, { remoteStart: true, exposeBattery: false, electricHint: true, sleep: async () => {} }, { stateChanged() {}, commandFailed: (_c, reason) => failed.push(reason) }, { ...log, debug: () => {} });
    await controller.command('remoteStart');
    const warn = logs.find((l) => l.startsWith('warn: remoteStart failed'));
    expect(warn).toContain('Vehicle not ready');
    expect(warn).not.toContain('eyJ');
    expect(failed[0]).toContain('Vehicle not ready');
  });

  it('adds nothing when the body is the generic Spring error, which carries no reason', () => {
    expect(refusalReason('{"status":400,"error":"Bad Request","path":"/v2/electric/command"}')).toBeUndefined();
    expect(new ApiHttpError(400, '{"status":400,"error":"Bad Request","path":"/v2/electric/command"}').message).toBe('Toyota connected services returned HTTP 400.');
    expect(refusalReason('not json')).toBeUndefined();
  });

  it('reads the other places Toyota puts a reason', () => {
    expect(refusalReason('{"status":{"messages":[{"description":"Door open"}]}}')).toBe('Door open');
    expect(refusalReason('{"payload":{"message":"Asleep"}}')).toBe('Asleep');
  });

  it('redacts bearer tokens, JWTs, key/value secrets, long opaque strings and VINs', () => {
    const out = redact('Bearer abc.def-ghi eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig "access_token":"xyz" apiKey=hunter2 0123456789abcdef0123456789abcdef01 TESTVIN0000000001');
    expect(out).not.toMatch(/abc\.def|eyJ|xyz|hunter2|0123456789abcdef/);
    expect(out).not.toContain('TESTVIN0000000001');
    expect(out).toContain('…0001');
  });
});
