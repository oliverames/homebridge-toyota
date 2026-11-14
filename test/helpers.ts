import type { FetchFn } from '../src/auth';

export function b64url(object: unknown): string {
  return Buffer.from(JSON.stringify(object)).toString('base64url');
}

export function makeJwt(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256' }): string {
  return `${b64url(header)}.${b64url(claims)}.sig`;
}

export function validIdToken(nowMs: number, overrides: Record<string, unknown> = {}): string {
  return makeJwt({ sub: 'guid-1234', aud: 'oneappsdkclient', exp: Math.floor(nowMs / 1000) + 3600, ...overrides });
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

export type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** A fetch double that records calls. No test ever touches the network. */
export function mockFetch(handler: Handler): { fn: FetchFn; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as FetchFn;
  return { fn, calls };
}

export function tokenBody(nowMs: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: 'access-A',
    refresh_token: 'refresh-A',
    id_token: validIdToken(nowMs),
    expires_in: 3600,
    ...extra,
  };
}
