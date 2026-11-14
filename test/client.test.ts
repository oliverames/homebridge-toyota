import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthHttpError, ToyotaAuth } from '../src/auth';
import { ApiHttpError, buildHeaders, ClientKeyRejectedError, OperationRejectedError, routes, routeUrl, ToyotaClient } from '../src/client';
import { parseConfig } from '../src/config';
import { FileStore, isSession, requiresRefresh, type Session } from '../src/session';
import { ACCESS_TOKEN_URL } from '../src/settings';
import { jsonResponse, mockFetch, tokenBody } from './helpers';

const NOW = 1_800_000_000_000;
const TEST_KEY = 'test-client-key-not-real';
const config = parseConfig({ username: 'driver@example.com', password: 'pw', apiKey: TEST_KEY }).config!;
const quiet = { debug() {}, info() {}, warn() {} };
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeStore(): FileStore<Session> {
  const dir = mkdtempSync(join(tmpdir(), 'toyota-test-'));
  dirs.push(dir);
  return new FileStore(join(dir, 'nested', 'session.json'), isSession);
}

const fresh: Session = { accessToken: 'tok', refreshToken: 'rt', idToken: 'id', expiresAt: NOW + 3_600_000, guid: 'g', deviceId: 'd', username: 'driver@example.com' };
const stale: Session = { ...fresh, expiresAt: NOW + 60_000 };

describe('session helpers', () => {
  it('requires refresh inside the 5 minute leeway', () => {
    expect(requiresRefresh({ ...fresh, expiresAt: NOW + 300_000 }, NOW)).toBe(true);
    expect(requiresRefresh({ ...fresh, expiresAt: NOW + 301_000 }, NOW)).toBe(false);
  });
  it('persists with owner-only permissions and survives garbage', () => {
    const store = makeStore();
    store.save(fresh);
    expect(store.load()).toEqual(fresh);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const path = (store as any).path as string;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    store.clear();
    expect(store.load()).toBeUndefined();
  });
});

describe('ToyotaClient token handling', () => {
  function build(handler: Parameters<typeof mockFetch>[0], store = makeStore()) {
    const net = mockFetch(handler);
    const auth = new ToyotaAuth(net.fn, undefined, () => NOW);
    return { client: new ToyotaClient(config, auth, store, net.fn, quiet, () => NOW), net, store };
  }

  it('reuses a stored, still-valid session without any request', async () => {
    const store = makeStore();
    store.save(fresh);
    const { client, net } = build(() => jsonResponse({ payload: { ok: 1 } }), store);
    const envelope = await client.send(() => routes.vehicles(), 'VIN', '21MM');
    expect(envelope.data).toEqual({ ok: 1 });
    expect(net.calls).toHaveLength(1);
    const headers = net.calls[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok');
    expect(headers['x-api-key']).toBe(TEST_KEY);
  });

  it('refreshes proactively and persists the rotated token before using it', async () => {
    const store = makeStore();
    store.save(stale);
    const { client, net } = build(
      (url) =>
        url === ACCESS_TOKEN_URL
          ? jsonResponse(tokenBody(NOW, { access_token: 'access-B', refresh_token: 'refresh-B' }))
          : jsonResponse({ payload: {} }),
      store,
    );
    await client.send(() => routes.vehicles(), 'VIN', '21MM');
    expect(net.calls.map((c) => (c.url === ACCESS_TOKEN_URL ? 'token' : 'api'))).toEqual(['token', 'api']);
    expect(store.load()?.refreshToken).toBe('refresh-B');
    expect((net.calls[1]?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer access-B');
  });

  it('shares one refresh between concurrent callers (refresh tokens are single use)', async () => {
    const store = makeStore();
    store.save(stale);
    const { client, net } = build((url) => (url === ACCESS_TOKEN_URL ? jsonResponse(tokenBody(NOW)) : jsonResponse({ payload: {} })), store);
    await Promise.all([client.send(() => routes.vehicles(), 'V', '21MM'), client.send(() => routes.vehicles(), 'V', '21MM')]);
    expect(net.calls.filter((c) => c.url === ACCESS_TOKEN_URL)).toHaveLength(1);
  });

  it('on 403 refreshes once and retries with the new token', async () => {
    const store = makeStore();
    store.save(fresh);
    let apiCalls = 0;
    const { client, net } = build((url, init) => {
      if (url === ACCESS_TOKEN_URL) return jsonResponse(tokenBody(NOW, { access_token: 'access-B' }));
      apiCalls++;
      const auth = (init?.headers as Record<string, string>)['authorization'];
      return auth === 'Bearer access-B' ? jsonResponse({ payload: { ok: true } }) : new Response('{"responseCode":"APIGW-403"}', { status: 403 });
    }, store);
    const envelope = await client.send(() => routes.vehicles(), 'V', '21MM');
    expect(envelope.data).toEqual({ ok: true });
    expect(apiCalls).toBe(2);
    expect(net.calls.filter((c) => c.url === ACCESS_TOKEN_URL)).toHaveLength(1);
  });

  it('a 403 that survives a fresh refresh is reported as a rotated client key', async () => {
    const store = makeStore();
    store.save(fresh);
    const { client } = build((url) => (url === ACCESS_TOKEN_URL ? jsonResponse(tokenBody(NOW)) : new Response('{"responseCode":"APIGW-403"}', { status: 403 })), store);
    await expect(client.send(() => routes.vehicles(), 'V', '21MM')).rejects.toBeInstanceOf(ClientKeyRejectedError);
  });

  it('surfaces 429 distinctly and does not refresh', async () => {
    const store = makeStore();
    store.save(fresh);
    const { client, net } = build(() => new Response('', { status: 429 }), store);
    const error = await client.send(() => routes.vehicles(), 'V', '21MM').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiHttpError);
    expect((error as ApiHttpError).isRateLimited).toBe(true);
    expect(net.calls).toHaveLength(1);
  });

  it('raises a rejection carried in an HTTP 200 body', async () => {
    const store = makeStore();
    store.save(fresh);
    const { client } = build(() => jsonResponse({ payload: { returnCode: 'VEHICLE_MOVING', message: 'moving' } }), store);
    await expect(client.send(() => routes.vehicles(), 'V', '21MM')).rejects.toBeInstanceOf(OperationRejectedError);
  });

  it('when the saved refresh token is dead, falls back to a full sign-in', async () => {
    const store = makeStore();
    store.save(stale);
    let tokenCalls = 0;
    const { client } = build((url) => {
      if (url === ACCESS_TOKEN_URL) {
        tokenCalls++;
        return tokenCalls === 1 ? new Response('{"error":"invalid_grant"}', { status: 400 }) : jsonResponse(tokenBody(NOW));
      }
      if (url.includes('/authenticate')) return jsonResponse({ tokenId: 'T' });
      if (url.includes('/authorize')) return new Response(null, { status: 302, headers: { location: 'com.toyota.oneapp:/oauth2Callback?code=C' } });
      return jsonResponse({ payload: {} });
    }, store);
    await client.send(() => routes.vehicles(), 'V', '21MM');
    expect(tokenCalls).toBe(2);
  });

  it('propagates other refresh failures without discarding the saved session', async () => {
    const store = makeStore();
    store.save(stale);
    const { client } = build(() => new Response('oops', { status: 500 }), store);
    await expect(client.send(() => routes.vehicles(), 'V', '21MM')).rejects.toBeInstanceOf(AuthHttpError);
    expect(store.load()).toEqual(stale);
  });

  it('ignores a stored session that belongs to a different account', async () => {
    const store = makeStore();
    store.save({ ...fresh, username: 'someone@else.com' });
    let signedIn = false;
    const { client } = build((url) => {
      if (url.includes('/authenticate')) { signedIn = true; return jsonResponse({ tokenId: 'T' }); }
      if (url.includes('/authorize')) return new Response(null, { status: 302, headers: { location: 'com.toyota.oneapp:/oauth2Callback?code=C' } });
      if (url === ACCESS_TOKEN_URL) return jsonResponse(tokenBody(NOW));
      return jsonResponse({ payload: {} });
    }, store);
    await client.send(() => routes.vehicles(), 'V', '21MM');
    expect(signedIn).toBe(true);
  });
});

describe('request building', () => {
  const ctx = { apiKey: TEST_KEY, appVersion: '3.5.0', session: fresh, vin: 'TESTVIN0000000001', generation: '21MM' as const };
  it('sends the OneApp header contract with the configured key', () => {
    const h = buildHeaders(ctx, routes.status('21MM'));
    expect(h['x-api-key']).toBe(TEST_KEY);
    expect(h['x-guid']).toBe('g');
    expect(h['x-channel']).toBe('ONEAPP');
    expect(h['x-brand']).toBe('T');
    expect(h['vin']).toBe(ctx.vin);
    expect(h['generation']).toBe('21MM');
    expect(h['x-correlationid']).toMatch(/[0-9a-f-]{36}/);
  });
  it('uses generation-specific routes', () => {
    expect(routeUrl(routes.status('21MM'))).toBe('https://onecdn.telematicsct.com/oneapi/v1/global/remote/status');
    expect(routeUrl(routes.status('17CY'))).toBe('https://onecdn.telematicsct.com/oneapi/v2/legacy/remote/status');
    expect(routes.remoteCommand('door-lock', '21MM', fresh, 'V').body).toEqual({ command: 'door-lock', autoFixPopup: false });
    expect(routes.remoteCommand('door-unlock', '17CY', fresh, 'V').body).toMatchObject({ command: { code: 'DL', value: 2 }, vin: 'V' });
    expect(routes.startClimate(fresh).extraHeaders).toEqual({ 'device-id': 'd' });
  });
});
