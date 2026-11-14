import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ToyotaAuth } from '../src/auth';
import { ToyotaClient } from '../src/client';
import { parseConfig } from '../src/config';
import { Poller } from '../src/poller';
import { FileStore, isSession, type Session } from '../src/session';
import { ACCESS_TOKEN_URL, API_GATEWAY, AUTHENTICATE_URL, AUTHORIZE_URL } from '../src/settings';
import { SignInService } from '../src/ui';
import { vehicleList } from './fixtures';
import { jsonResponse, mockFetch, tokenBody } from './helpers';

const NOW = 1_800_000_000_000;
const EMAIL = 'driver@example.com';
const PASSWORD = 'hunter2-test';
const KEY = 'test-client-key-not-real';
const CODE = '482913';

const nameCb = { type: 'NameCallback', output: [{ name: 'prompt', value: 'User Name' }], input: [{ name: 'IDToken1', value: '' }] };
const passCb = { type: 'PasswordCallback', output: [{ name: 'prompt', value: 'Password' }], input: [{ name: 'IDToken2', value: '' }] };
const otpCb = { type: 'PasswordCallback', output: [{ name: 'prompt', value: 'One Time Password' }], input: [{ name: 'IDToken1', value: '' }] };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function workspace(platform: Record<string, unknown> | null = { platform: 'Toyota', username: EMAIL, password: PASSWORD, apiKey: KEY }) {
  const storagePath = mkdtempSync(join(tmpdir(), 'toyota-ui-'));
  dirs.push(storagePath);
  const configPath = join(storagePath, 'config.json');
  writeFileSync(configPath, JSON.stringify({ bridge: {}, platforms: platform ? [{ platform: 'Other' }, platform] : [] }));
  const sessionPath = join(storagePath, 'homebridge-toyota', 'session.json');
  return { storagePath, configPath, sessionPath };
}

/** Scripted ForgeRock login that asks for a code, then (after the code) succeeds. */
function toyota(options: { otp?: boolean; rejectCode?: boolean; reprompt?: boolean } = {}) {
  const { otp = true, rejectCode = false, reprompt = false } = options;
  let answered = false;
  const net = mockFetch((url, init) => {
    if (url === AUTHENTICATE_URL) {
      const body = JSON.parse(String(init?.body)) as { authId?: string; callbacks?: { input: { value: string }[] }[] };
      if (!body.authId) return jsonResponse({ authId: 'a1', callbacks: [nameCb, passCb] });
      if (body.authId === 'a1') return jsonResponse(otp ? { authId: 'a2', callbacks: [otpCb] } : { tokenId: 'TOKEN' });
      // authId a2: the code answer
      answered = true;
      if (reprompt) return jsonResponse({ authId: 'a3', callbacks: [otpCb] });
      return rejectCode ? new Response('{}', { status: 401 }) : jsonResponse({ tokenId: 'TOKEN' });
    }
    if (url.startsWith(AUTHORIZE_URL)) {
      return new Response(null, { status: 302, headers: { location: 'com.toyota.oneapp:/oauth2Callback?code=CODE123' } });
    }
    if (url === ACCESS_TOKEN_URL) return jsonResponse(tokenBody(NOW));
    if (url === `${API_GATEWAY}v2/vehicle/guid`) return jsonResponse(vehicleList);
    throw new Error(`unexpected ${url}`);
  });
  return { ...net, codeAnswered: () => answered };
}

function service(ws: ReturnType<typeof workspace>, net: ReturnType<typeof toyota>) {
  return new SignInService({ storagePath: ws.storagePath, configPath: ws.configPath, fetchFn: net.fn, now: () => NOW });
}

describe('SignInService', () => {
  it('reports not signed in before anything happens', () => {
    const ws = workspace();
    expect(service(ws, toyota()).status()).toMatchObject({ configured: true, signedIn: false, codePending: false });
  });

  it('asks for saved settings when the config has no Toyota entry', async () => {
    const ws = workspace(null);
    const net = toyota();
    const result = await service(ws, net).start();
    expect(result).toMatchObject({ outcome: 'error', configured: false });
    expect(net.calls).toHaveLength(0);
  });

  it('start sends the code, verify completes the login and writes the session file', async () => {
    const ws = workspace();
    const net = toyota();
    const svc = service(ws, net);

    const started = await svc.start();
    expect(started).toMatchObject({ outcome: 'codeSent', codePending: true, signedIn: false });
    expect(started.codeExpiresAt).toBe(NOW + 10 * 60 * 1000);

    const verified = await svc.verify(CODE);
    expect(verified).toMatchObject({ outcome: 'signedIn', signedIn: true, account: EMAIL, vehicleCount: 2, codePending: false });
    expect(net.codeAnswered()).toBe(true);

    const body = net.calls.filter((c) => c.url === AUTHENTICATE_URL).map((c) => JSON.parse(String(c.init?.body)) as { authId?: string; callbacks?: { input: { value: string }[] }[] });
    expect(body[2]?.authId).toBe('a2');
    expect(body[2]?.callbacks?.[0]?.input[0]?.value).toBe(CODE);

    const stored = new FileStore<Session>(ws.sessionPath, isSession).load();
    expect(stored).toMatchObject({ username: EMAIL, accessToken: 'access-A', refreshToken: 'refresh-A' });
    expect(statSync(ws.sessionPath).mode & 0o777).toBe(0o600);
    expect(service(ws, net).status()).toMatchObject({ signedIn: true, vehicleCount: 2 });
  });

  it('signs in directly when Toyota does not ask for a code', async () => {
    const ws = workspace();
    const result = await service(ws, toyota({ otp: false })).start();
    expect(result).toMatchObject({ outcome: 'signedIn', signedIn: true });
  });

  it('verify without a pending code does not call Toyota', async () => {
    const ws = workspace();
    const net = toyota();
    const result = await service(ws, net).verify(CODE);
    expect(result.outcome).toBe('error');
    expect(net.calls).toHaveLength(0);
  });

  it('rejects an empty or malformed code locally', async () => {
    const ws = workspace();
    const net = toyota();
    const svc = service(ws, net);
    await svc.start();
    const before = net.calls.length;
    expect((await svc.verify('  ')).outcome).toBe('error');
    expect((await svc.verify('12 34')).outcome).toBe('error');
    expect((await svc.verify({ code: CODE })).outcome).toBe('error');
    expect(net.calls).toHaveLength(before);
  });

  it('asks for a new code when Toyota ends the login on a wrong code', async () => {
    const ws = workspace();
    const svc = service(ws, toyota({ rejectCode: true }));
    await svc.start();
    const result = await svc.verify('000000');
    expect(result).toMatchObject({ outcome: 'error', codePending: false, signedIn: false });
  });

  it('keeps waiting when Toyota shows the code prompt again with a new code', async () => {
    const ws = workspace();
    const svc = service(ws, toyota({ reprompt: true }));
    await svc.start();
    const result = await svc.verify('000000');
    expect(result).toMatchObject({ outcome: 'codeSent', codePending: true, signedIn: false });
  });

  it('treats a code older than 10 minutes as gone', async () => {
    const ws = workspace();
    const net = toyota();
    let clock = NOW;
    const svc = new SignInService({ storagePath: ws.storagePath, configPath: ws.configPath, fetchFn: net.fn, now: () => clock });
    await svc.start();
    clock += 11 * 60 * 1000;
    expect(svc.status().codePending).toBe(false);
    expect((await svc.verify(CODE)).outcome).toBe('error');
  });

  it('starting again discards the old challenge and requests a fresh code', async () => {
    const ws = workspace();
    const net = toyota();
    const svc = service(ws, net);
    await svc.start();
    await svc.start();
    // two full logins began from scratch: two requests without an authId
    const fresh = net.calls.filter((c) => c.url === AUTHENTICATE_URL && !(JSON.parse(String(c.init?.body)) as { authId?: string }).authId);
    expect(fresh).toHaveLength(2);
  });

  it('reports wrong credentials without echoing them', async () => {
    const ws = workspace();
    const net = mockFetch((url, init) => {
      if (url === AUTHENTICATE_URL) {
        const body = JSON.parse(String(init?.body)) as { authId?: string };
        return body.authId ? jsonResponse({ error: 'denied' }) : jsonResponse({ authId: 'a1', callbacks: [nameCb, passCb] });
      }
      throw new Error(`unexpected ${url}`);
    });
    const result = await new SignInService({ storagePath: ws.storagePath, configPath: ws.configPath, fetchFn: net.fn, now: () => NOW }).start();
    expect(result.outcome).toBe('error');
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it('never returns tokens, the password, the client key or the code', async () => {
    const ws = workspace();
    const svc = service(ws, toyota());
    const responses = [svc.status(), await svc.start(), await svc.verify(CODE), svc.status()];
    const text = JSON.stringify(responses);
    for (const secret of [PASSWORD, KEY, CODE, 'access-A', 'refresh-A', 'TOKEN']) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).not.toMatch(/guid-1234|deviceId/);
  });

  it('still signs in when the vehicle lookup fails', async () => {
    const ws = workspace();
    const base = toyota({ otp: false });
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return url.startsWith(API_GATEWAY) ? new Response('{}', { status: 500 }) : base.fn(input, init);
    }) as typeof fetch;
    const result = await new SignInService({ storagePath: ws.storagePath, configPath: ws.configPath, fetchFn: fn, now: () => NOW }).start();
    expect(result).toMatchObject({ outcome: 'signedIn', signedIn: true });
    expect(result.message).toContain('vehicle lookup failed');
  });
});

describe('platform pickup of a session written by the settings page', () => {
  const quiet = { debug() {}, info() {}, warn() {} };
  const config = parseConfig({ username: EMAIL, password: PASSWORD, apiKey: KEY }).config!;
  const base: Session = { accessToken: 'tok-1', refreshToken: 'rt-1', idToken: 'id', expiresAt: NOW + 3_600_000, guid: 'g', deviceId: 'd', username: EMAIL };

  it('reloads the session file when another process rewrites it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'toyota-pickup-'));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const store = new FileStore<Session>(join(dir, 'session.json'), isSession);
    const net = mockFetch(() => jsonResponse({}));
    const client = new ToyotaClient(config, new ToyotaAuth(net.fn, undefined, () => NOW), store, net.fn, quiet, () => NOW);

    expect(client.sessionFileChanged()).toBe(false); // no file yet
    store.save(base);
    expect(client.sessionFileChanged()).toBe(true);
    expect((await client.ensureSession()).accessToken).toBe('tok-1');
    expect(client.sessionFileChanged()).toBe(false);

    // Another process (the UI server) writes a new session later.
    store.save({ ...base, accessToken: 'tok-2', refreshToken: 'rt-2' });
    const t = new Date(Date.now() + 5000);
    (await import('node:fs')).utimesSync(join(dir, 'session.json'), t, t);
    expect(client.sessionFileChanged()).toBe(true);
    expect((await client.ensureSession()).accessToken).toBe('tok-2');
    expect(client.sessionFileChanged()).toBe(false);
    expect(readFileSync(join(dir, 'session.json'), 'utf8')).toContain('tok-2');
    expect(net.calls).toHaveLength(0);
  });

  it('does not mistake its own refresh write for an outside change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'toyota-pickup-'));
    dirs.push(dir);
    const store = new FileStore<Session>(join(dir, 'session.json'), isSession);
    store.save({ ...base, expiresAt: NOW + 60_000 });
    const net = mockFetch((url) => (url === ACCESS_TOKEN_URL ? jsonResponse(tokenBody(NOW, { refresh_token: 'rt-new' })) : jsonResponse({})));
    const client = new ToyotaClient(config, new ToyotaAuth(net.fn, undefined, () => NOW), store, net.fn, quiet, () => NOW);
    await client.ensureSession();
    expect(store.load()?.refreshToken).toBe('rt-new');
    expect(client.sessionFileChanged()).toBe(false);
  });
});

describe('Poller resume', () => {
  it('start() restarts a poller that stopped on a fatal outcome', async () => {
    let runs = 0;
    const poller = new Poller(async () => (++runs === 1 ? 'fatal' : 'ok'), 60_000);
    poller.start(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toBe(1);
    poller.start(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toBe(2);
    poller.stop();
  });
});
