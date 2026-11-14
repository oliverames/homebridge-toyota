import { isObject, str } from './json';
import { validatedPayload } from './jwt';
import { newDeviceId, type Session } from './session';
import {
  ACCESS_TOKEN_URL,
  AUTHENTICATE_URL,
  AUTHORIZE_URL,
  OAUTH_CLIENT_ID,
  OAUTH_REDIRECT_URI,
} from './settings';

export type FetchFn = typeof fetch;

export class AuthError extends Error {}
export class OtpRequiredError extends AuthError {
  constructor() {
    super('Toyota sent a one-time passcode. Enter it in the plugin config (oneTimePasscode) and restart.');
  }
}
export class OtpRejectedError extends AuthError {
  constructor() {
    super('Toyota did not accept the one-time passcode. A new code was requested; enter it and restart.');
  }
}
export class InvalidCredentialsError extends AuthError {
  constructor() {
    super('Toyota rejected the supplied credentials.');
  }
}
export class AuthHttpError extends AuthError {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Toyota authentication returned HTTP ${status}.`);
  }

  /** Refresh tokens are single use; a spent or expired one answers 400/401 invalid_grant. */
  get isRefreshTokenRejection(): boolean {
    if (this.status !== 400 && this.status !== 401) {
      return false;
    }
    const body = this.body.toLowerCase();
    return body.includes('invalid_grant') || body.includes('grant is invalid');
  }
}

export interface PendingChallenge {
  username: string;
  payload: Record<string, unknown>;
  savedAt: number;
}

export interface ChallengeStore {
  load(): PendingChallenge | undefined;
  save(challenge: PendingChallenge): void;
  clear(): void;
}

export interface Credentials {
  username: string;
  password: string;
  otp?: string;
}

/** A challenge older than this is dropped rather than answered. */
export const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MAX_STEPS = 15;

type Callback = Record<string, unknown>;

function promptOf(callback: Callback): string {
  const output = callback['output'];
  if (Array.isArray(output) && isObject(output[0])) {
    return str(output[0]['value']) ?? '';
  }
  return '';
}

function settingInput(callback: Callback, value: unknown): Callback {
  const input = callback['input'];
  if (!Array.isArray(input) || input.length === 0 || !isObject(input[0])) {
    return callback;
  }
  const first = { ...input[0], value };
  return { ...callback, input: [first, ...input.slice(1)] };
}

/** Blank every callback input so no password is ever written to disk. */
export function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const callbacks = payload['callbacks'];
  if (!Array.isArray(callbacks)) {
    return payload;
  }
  return {
    ...payload,
    callbacks: callbacks.map((cb) => (isObject(cb) ? settingInput(cb, '') : cb)),
  };
}

function formBody(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

export class ToyotaAuth {
  constructor(
    private readonly fetchFn: FetchFn,
    private readonly challenges?: ChallengeStore,
    private readonly now: () => number = Date.now,
  ) {}

  async signIn(credentials: Credentials): Promise<Session> {
    const tokenId = await this.authenticate(credentials);
    const code = await this.authorizationCode(tokenId);
    return this.requestTokens(code, credentials.username);
  }

  async refresh(session: Session): Promise<Session> {
    const response = await this.postToken({
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      grant_type: 'refresh_token',
      code_verifier: 'plain',
      refresh_token: session.refreshToken,
    });
    return this.buildSession(response, session.username, session.deviceId);
  }

  private pendingFor(username: string): PendingChallenge | undefined {
    const pending = this.challenges?.load();
    if (!pending) {
      return undefined;
    }
    const fresh = this.now() - pending.savedAt < CHALLENGE_TTL_MS;
    if (!fresh || pending.username.toLowerCase() !== username.toLowerCase()) {
      this.challenges?.clear();
      return undefined;
    }
    return pending;
  }

  private async authenticate(credentials: Credentials): Promise<string> {
    const pending = this.pendingFor(credentials.username);
    let payload: Record<string, unknown> = pending?.payload ?? {};
    // A code answers only the challenge it was issued for. A fresh login makes
    // Toyota send a new code, and a prompt shown again after a code means the
    // code was rejected.
    let mayAnswerOtp = pending !== undefined;
    let submittedOtp = false;

    for (let step = 0; step < MAX_STEPS; step++) {
      const callbacks = payload['callbacks'];
      if (Array.isArray(callbacks)) {
        let needsOtp = false;
        const filled: unknown[] = callbacks.map((raw) => {
          if (!isObject(raw)) {
            return raw;
          }
          const cb: Callback = raw;
          const type = cb['type'];
          const prompt = promptOf(cb);
          if (type === 'NameCallback') {
            if (prompt === 'User Name') {
              return settingInput(cb, credentials.username);
            }
            if (prompt === 'ui_locales') {
              return settingInput(cb, 'en-US');
            }
          } else if (type === 'PasswordCallback') {
            if (prompt === 'One Time Password') {
              if (!mayAnswerOtp || !credentials.otp) {
                needsOtp = true;
                return cb;
              }
              mayAnswerOtp = false;
              submittedOtp = true;
              return settingInput(cb, credentials.otp);
            }
            return settingInput(cb, credentials.password);
          } else if (type === 'ChoiceCallback' || type === 'ConfirmationCallback') {
            return settingInput(cb, 0);
          }
          return cb;
        });
        payload = { ...payload, callbacks: filled };
        if (needsOtp) {
          this.challenges?.save({
            username: credentials.username,
            payload: redactPayload(payload),
            savedAt: this.now(),
          });
          throw submittedOtp ? new OtpRejectedError() : new OtpRequiredError();
        }
      }

      const response = await this.fetchFn(AUTHENTICATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-API-Version': 'resource=2.1, protocol=1.0' },
        body: JSON.stringify(payload),
      });
      if (submittedOtp && (response.status === 401 || response.status === 403)) {
        this.challenges?.clear();
        throw new OtpRejectedError();
      }
      const text = await response.text();
      if (!response.ok) {
        throw new AuthHttpError(response.status, text);
      }
      let object: unknown;
      try {
        object = JSON.parse(text);
      } catch {
        throw new AuthError('Toyota returned an unexpected authentication response.');
      }
      if (!isObject(object)) {
        throw new AuthError('Toyota returned an unexpected authentication response.');
      }
      const tokenId = str(object['tokenId']);
      if (tokenId) {
        this.challenges?.clear();
        return tokenId;
      }
      if (object['callbacks'] === undefined) {
        this.challenges?.clear();
        throw new InvalidCredentialsError();
      }
      payload = object;
    }
    throw new AuthError('Toyota authentication did not finish.');
  }

  private async authorizationCode(tokenId: string): Promise<string> {
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      scope: 'openid profile write',
      response_type: 'code',
      redirect_uri: OAUTH_REDIRECT_URI,
      code_challenge: 'plain',
      code_challenge_method: 'plain',
    }).toString();
    const response = await this.fetchFn(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { Cookie: `iPlanetDirectoryPro=${tokenId}`, 'Accept-API-Version': 'resource=2.1, protocol=1.0' },
    });
    const location = response.headers.get('location');
    if (!location) {
      throw new AuthError('Toyota did not return an authorization code.');
    }
    // The redirect target uses a custom scheme, so parse the query manually.
    const query = location.includes('?') ? location.slice(location.indexOf('?') + 1) : '';
    const code = new URLSearchParams(query).get('code');
    if (!code) {
      throw new AuthError('Toyota did not return an authorization code.');
    }
    return code;
  }

  private async requestTokens(code: string, username: string): Promise<Session> {
    const response = await this.postToken({
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: 'plain',
      code,
    });
    return this.buildSession(response, username, newDeviceId());
  }

  private async postToken(values: Record<string, string>): Promise<TokenResponse> {
    const response = await this.fetchFn(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody(values),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AuthHttpError(response.status, text);
    }
    return parseTokenResponse(text);
  }

  private buildSession(tokens: TokenResponse, username: string, deviceId: string): Session {
    const payload = validatedPayload(tokens.idToken, OAUTH_CLIENT_ID, this.now());
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt: this.now() + tokens.expiresIn * 1000,
      guid: payload.sub,
      deviceId,
      username,
    };
  }
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresIn: number;
}

export function parseTokenResponse(text: string): TokenResponse {
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    throw new AuthError('Toyota returned an unexpected token response.');
  }
  if (!isObject(object)) {
    throw new AuthError('Toyota returned an unexpected token response.');
  }
  const accessToken = str(object['access_token']);
  const refreshToken = str(object['refresh_token']);
  const idToken = str(object['id_token']);
  const expiresIn = typeof object['expires_in'] === 'number' ? object['expires_in'] : undefined;
  if (!accessToken || !refreshToken || !idToken || expiresIn === undefined) {
    throw new AuthError('Toyota returned an unexpected token response.');
  }
  return { accessToken, refreshToken, idToken, expiresIn };
}
