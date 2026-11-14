import { describe, expect, it } from 'vitest';
import {
  AuthHttpError,
  type ChallengeStore,
  InvalidCredentialsError,
  OtpRejectedError,
  OtpRequiredError,
  type PendingChallenge,
  redactPayload,
  ToyotaAuth,
} from '../src/auth';
import { ACCESS_TOKEN_URL, AUTHENTICATE_URL, AUTHORIZE_URL } from '../src/settings';
import { jsonResponse, mockFetch, tokenBody } from './helpers';

const NOW = 1_800_000_000_000;
const creds = { username: 'driver@example.com', password: 'hunter2-test' };

const nameCb = { type: 'NameCallback', output: [{ name: 'prompt', value: 'User Name' }], input: [{ name: 'IDToken1', value: '' }] };
const passCb = { type: 'PasswordCallback', output: [{ name: 'prompt', value: 'Password' }], input: [{ name: 'IDToken2', value: '' }] };
const otpCb = { type: 'PasswordCallback', output: [{ name: 'prompt', value: 'One Time Password' }], input: [{ name: 'IDToken1', value: '' }] };

function memoryChallenges(): ChallengeStore & { value?: PendingChallenge } {
  const store: ChallengeStore & { value?: PendingChallenge } = {
    load: () => store.value,
    save: (c) => {
      store.value = c;
    },
    clear: () => {
      store.value = undefined;
    },
  };
  return store;
}

/** Scripted ForgeRock journey: authenticate steps, then authorize redirect, then tokens. */
function journey(steps: unknown[]) {
  let step = 0;
  return mockFetch((url, init) => {
    if (url === AUTHENTICATE_URL) {
      const next = steps[step++];
      return next instanceof Response ? next : jsonResponse(next);
    }
    if (url.startsWith(AUTHORIZE_URL)) {
      return new Response(null, { status: 302, headers: { location: 'com.toyota.oneapp:/oauth2Callback?code=CODE123&iss=x' } });
    }
    if (url === ACCESS_TOKEN_URL) {
      expect(String(init?.body)).toContain('code=CODE123');
      return jsonResponse(tokenBody(NOW));
    }
    throw new Error(`unexpected ${url}`);
  });
}

describe('signIn', () => {
  it('walks callbacks, trades tokenId for a code, and builds a session', async () => {
    const { fn, calls } = journey([{ authId: 'a1', callbacks: [nameCb, passCb] }, { tokenId: 'TOKEN' }]);
    const session = await new ToyotaAuth(fn, undefined, () => NOW).signIn(creds);
    expect(session).toMatchObject({ accessToken: 'access-A', refreshToken: 'refresh-A', guid: 'guid-1234', username: creds.username });
    expect(session.expiresAt).toBe(NOW + 3_600_000);
    expect(session.deviceId).toMatch(/^[0-9a-f]{64}$/);
    const second = JSON.parse(String(calls[1]?.init?.body)) as { callbacks: { input: { value: string }[] }[] };
    expect(second.callbacks.map((c) => c.input[0]?.value)).toEqual([creds.username, creds.password]);
    const authorize = calls.find((c) => c.url.startsWith(AUTHORIZE_URL));
    expect((authorize?.init?.headers as Record<string, string>)['Cookie']).toBe('iPlanetDirectoryPro=TOKEN');
    expect(authorize?.init?.redirect).toBe('manual');
  });

  it('reports invalid credentials when the journey ends without a token or callbacks', async () => {
    const { fn } = journey([{ authId: 'a1', callbacks: [nameCb, passCb] }, { error: 'denied' }]);
    await expect(new ToyotaAuth(fn, undefined, () => NOW).signIn(creds)).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('raises AuthHttpError on a failed step', async () => {
    const { fn } = journey([new Response('{"message":"x"}', { status: 500 })]);
    await expect(new ToyotaAuth(fn, undefined, () => NOW).signIn(creds)).rejects.toBeInstanceOf(AuthHttpError);
  });
});

describe('one-time passcode', () => {
  it('stops at the OTP prompt, persists a redacted challenge, and resumes with the code', async () => {
    const challenges = memoryChallenges();
    const first = journey([{ authId: 'a1', callbacks: [nameCb, passCb] }, { authId: 'a2', callbacks: [otpCb] }]);
    await expect(new ToyotaAuth(first.fn, challenges, () => NOW).signIn(creds)).rejects.toBeInstanceOf(OtpRequiredError);

    const saved = JSON.stringify(challenges.value);
    expect(saved).not.toContain(creds.password);
    expect(challenges.value?.payload['authId']).toBe('a2');

    // Restart: the same challenge is answered, no fresh login is started.
    const second = journey([{ tokenId: 'TOKEN' }]);
    const session = await new ToyotaAuth(second.fn, challenges, () => NOW + 60_000).signIn({ ...creds, otp: '123456' });
    expect(session.guid).toBe('guid-1234');
    const body = JSON.parse(String(second.calls[0]?.init?.body)) as { authId: string; callbacks: { input: { value: string }[] }[] };
    expect(body.authId).toBe('a2');
    expect(body.callbacks[0]?.input[0]?.value).toBe('123456');
    expect(challenges.value).toBeUndefined();
  });

  it('does not answer with a code when there is no pending challenge (fresh login)', async () => {
    const { fn } = journey([{ authId: 'a1', callbacks: [nameCb, passCb] }, { authId: 'a2', callbacks: [otpCb] }]);
    await expect(new ToyotaAuth(fn, memoryChallenges(), () => NOW).signIn({ ...creds, otp: '000000' })).rejects.toBeInstanceOf(OtpRequiredError);
  });

  it('drops a stale challenge', async () => {
    const challenges = memoryChallenges();
    challenges.value = { username: creds.username, payload: { authId: 'old', callbacks: [otpCb] }, savedAt: NOW - 3_600_000 };
    const { fn } = journey([{ authId: 'a1', callbacks: [nameCb, passCb] }, { tokenId: 'TOKEN' }]);
    await new ToyotaAuth(fn, challenges, () => NOW).signIn({ ...creds, otp: '123456' });
    expect(challenges.value).toBeUndefined();
  });

  it('reports a rejected code when Toyota ends the login on it', async () => {
    const challenges = memoryChallenges();
    challenges.value = { username: creds.username, payload: { authId: 'a2', callbacks: [otpCb] }, savedAt: NOW };
    const { fn } = journey([new Response('{}', { status: 401 })]);
    await expect(new ToyotaAuth(fn, challenges, () => NOW).signIn({ ...creds, otp: '111111' })).rejects.toBeInstanceOf(OtpRejectedError);
    expect(challenges.value).toBeUndefined();
  });

  it('redactPayload blanks every input', () => {
    const redacted = redactPayload({ authId: 'x', callbacks: [{ ...passCb, input: [{ name: 'IDToken2', value: 'secret' }] }] });
    expect(JSON.stringify(redacted)).not.toContain('secret');
  });
});

describe('refresh', () => {
  const session = {
    accessToken: 'old', refreshToken: 'refresh-old', idToken: 'x', expiresAt: NOW, guid: 'g', deviceId: 'dev', username: creds.username,
  };

  it('posts a refresh_token grant and keeps the device id', async () => {
    const { fn, calls } = mockFetch(() => jsonResponse(tokenBody(NOW, { access_token: 'access-B', refresh_token: 'refresh-B' })));
    const next = await new ToyotaAuth(fn, undefined, () => NOW).refresh(session);
    expect(next).toMatchObject({ accessToken: 'access-B', refreshToken: 'refresh-B', deviceId: 'dev', guid: 'guid-1234' });
    const body = String(calls[0]?.init?.body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=refresh-old');
  });

  it('flags a spent refresh token as a rejection', async () => {
    const { fn } = mockFetch(() => new Response('{"error":"invalid_grant"}', { status: 400 }));
    const error = await new ToyotaAuth(fn, undefined, () => NOW).refresh(session).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthHttpError);
    expect((error as AuthHttpError).isRefreshTokenRejection).toBe(true);
  });

  it('does not flag other failures as a rejection', () => {
    expect(new AuthHttpError(500, 'invalid_grant').isRefreshTokenRejection).toBe(false);
    expect(new AuthHttpError(400, 'bad request').isRefreshTokenRejection).toBe(false);
  });

  it('rejects a token response with a bad id_token', async () => {
    const { fn } = mockFetch(() => jsonResponse(tokenBody(NOW, { id_token: 'garbage' })));
    await expect(new ToyotaAuth(fn, undefined, () => NOW).refresh(session)).rejects.toThrow();
  });
});
