import { AuthHttpError, type FetchFn, type ToyotaAuth } from './auth';
import type { ToyotaConfig } from './config';
import { type Envelope, findRejection, parseEnvelope } from './envelope';
import { isObject, str } from './json';
import type { Generation } from './parse';
import { redact } from './redact';
import { FileStore, requiresRefresh, type Session } from './session';
import { API_GATEWAY, GRAPHQL_ENDPOINT, SERVICES_GATEWAY } from './settings';

export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Toyota connected services returned HTTP ${status}${detail(body)}.`);
  }
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

export class OperationRejectedError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string | undefined,
  ) {
    super(`Toyota rejected the request${code ? ` (${redact(code)})` : ''}: ${message ? redact(message) : 'the vehicle did not accept it'}`);
  }
}

/**
 * 403s that keep surviving successful token refreshes point at the client key,
 * not the login. A single one does not: Toyota also answers 403 while its
 * gateway is unhealthy.
 */
export class ClientKeyRejectedError extends Error {
  constructor() {
    super(
      'Toyota kept rejecting requests even with a freshly refreshed sign-in. The "apiKey" client key has most likely been rotated; update it in the plugin config.',
    );
  }
}

export class UnsupportedError extends Error {}

/** Pulls the first human-readable refusal reason out of an error body, as RedLink does. */
export function refusalReason(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const candidates: unknown[] = [];
  const collect = (value: unknown): void => {
    if (!isObject(value)) {
      return;
    }
    candidates.push(value['message'], value['description'], value['detail'], value['reason'], value['errorMessage'], value['error_description']);
    const errors = value['errors'];
    if (Array.isArray(errors)) {
      for (const entry of errors) {
        if (isObject(entry)) {
          candidates.push(entry['message'], entry['detailedDescription'], entry['description']);
        }
      }
    }
    const status = value['status'];
    if (isObject(status) && Array.isArray(status['messages'])) {
      for (const entry of status['messages']) {
        if (isObject(entry)) {
          candidates.push(entry['detailedDescription'], entry['description']);
        }
      }
    }
  };
  collect(parsed);
  if (isObject(parsed)) {
    collect(parsed['payload']);
  }
  for (const candidate of candidates) {
    const text = str(candidate);
    if (text) {
      return redact(text).slice(0, 300);
    }
  }
  return undefined;
}

function detail(body: string): string {
  const reason = refusalReason(body);
  return reason ? `: ${reason}` : '';
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: unknown;
  extraHeaders?: Record<string, string>;
  servicesGateway?: boolean;
}

export interface RequestContext {
  apiKey: string;
  appVersion: string;
  session: Pick<Session, 'accessToken' | 'guid' | 'deviceId'>;
  vin: string;
  generation: Generation;
  correlationId?: string;
}

/** Header set mirrors OneApp v3.5.0 BasicInterceptor as ported by RedLink. */
export function buildHeaders(ctx: RequestContext, route: Route): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.session.accessToken}`,
    'x-api-key': ctx.apiKey,
    'x-guid': ctx.session.guid,
    'x-channel': 'ONEAPP',
    'x-appbrand': 'T',
    'x-brand': 'T',
    'x-region': 'US',
    'x-appversion': ctx.appVersion,
    'x-osname': 'iOS',
    'x-osversion': '18.0',
    'x-device-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    'x-locale': 'en-US',
    'user-agent': 'homebridge-toyota',
    accept: 'application/json',
    vin: ctx.vin,
    'x-vin': ctx.vin,
    'x-generation': ctx.generation,
    generation: ctx.generation,
    // Some EV routes answer 500 without a correlation id; harmless elsewhere.
    // Uppercase, as the OneApp and RedLink (UUID().uuidString) send it.
    'x-correlationid': ctx.correlationId ?? crypto.randomUUID().toUpperCase(),
  };
  for (const [key, value] of Object.entries(route.extraHeaders ?? {})) {
    headers[key.toLowerCase()] = value;
  }
  if (route.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return headers;
}

export function routeUrl(route: Route): string {
  return new URL(route.path, route.servicesGateway ? SERVICES_GATEWAY : API_GATEWAY).toString();
}

/* Routes (paths come from RedLink's ToyotaRequestFactory). */

export const routes = {
  vehicles: (): Route => ({ method: 'GET', path: 'v2/vehicle/guid' }),
  status: (g: Generation): Route => ({
    method: 'GET',
    path: g === '17CY' ? 'v2/legacy/remote/status' : 'v1/global/remote/status',
  }),
  engineStatus: (g: Generation): Route => ({
    method: 'GET',
    path: g === '17CY' ? 'v1/legacy/remote/engine-status' : 'v1/global/remote/engine-status',
  }),
  climateStatus: (): Route => ({ method: 'GET', path: 'v1/global/remote/climate-status' }),
  telemetry: (g: Generation): Route =>
    g === '17CY'
      ? { method: 'GET', path: 'v2/telemetry', extraHeaders: { GENERATION: '17CY' } }
      : { method: 'GET', path: 'v3/telemetry', extraHeaders: { GENERATION: g } },
  electricStatus: (version: 'v3' | 'v2' = 'v3'): Route => ({ method: 'GET', path: `${version}/electric/status` }),
  /** Lock/unlock/engine-start/engine-stop on every generation except 24MM (GraphQL). */
  remoteCommand: (command: RemoteCommand, g: Generation, session: Session, vin: string): Route => {
    if (g === '17CY') {
      const legacy = LEGACY_CODES[command];
      if (!legacy) {
        throw new UnsupportedError(`${command} is not available on 17CY vehicles.`);
      }
      const [code, value] = legacy;
      return {
        method: 'POST',
        path: 'v1/legacy/remote/command',
        body: { command: { code, value }, guid: session.guid, deviceId: session.deviceId, deviceType: 'iOS', vin },
      };
    }
    return { method: 'POST', path: 'v1/global/remote/command', body: { command, autoFixPopup: false } };
  },
  /**
   * Asks the vehicle to upload a fresh status report (RedLink's `refreshStatus`).
   * This wakes the car, so the controller rations it. 24MM uses a GraphQL mutation instead and is not supported here.
   */
  refreshStatus: (g: Generation, session: Session, vin: string): Route => {
    if (g === '24MM') {
      throw new UnsupportedError('Requesting a fresh report is not available on 24MM vehicles yet.');
    }
    if (g === '17CY') {
      return {
        method: 'POST',
        path: 'v1/legacy/remote/refresh-status',
        body: { guid: session.guid, deviceId: session.deviceId, deviceType: 'iOS', vin },
      };
    }
    return { method: 'POST', path: 'v1/global/remote/refresh-status', body: { guid: session.guid, deviceId: session.deviceId, vin } };
  },
  startClimate: (session: Session): Route => ({
    method: 'POST',
    path: 'v2/electric/command',
    body: { command: 'startClimate', remoteHvac: { settingType: 'AUTO', temperature: 68.0, temperatureUnit: 'F' } },
    extraHeaders: { 'device-id': session.deviceId },
  }),
  stopClimate: (session: Session): Route => ({
    method: 'POST',
    path: 'v2/electric/command',
    body: { command: 'stopClimate' },
    extraHeaders: { 'device-id': session.deviceId },
  }),
};

export type RemoteCommand =
  | 'door-lock'
  | 'door-unlock'
  | 'engine-start'
  | 'engine-stop'
  | 'power-window-close'
  | 'sunroof-close'
  | 'trunk-lock'
  | 'trunk-unlock';

/** 17CY has no window, moonroof or hatch commands (RedLink lists them for 17CYPLUS, 21MM and 24MM only). */
const LEGACY_CODES: Partial<Record<RemoteCommand, [string, number]>> = {
  'door-lock': ['DL', 1],
  'door-unlock': ['DL', 2],
  'engine-start': ['RES', 1],
  'engine-stop': ['RES', 2],
};

export interface ClientLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

/** Minimum gap between refreshes forced by a 401/403. */
export const FORCED_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
/** Consecutive refreshed-and-still-refused requests before the client key is blamed. */
export const KEY_REJECTION_THRESHOLD = 3;

export interface ClientOptions {
  forcedRefreshCooldownMs?: number;
  /** 1 for a one-shot check (the settings page), where there is no later request to wait for. */
  keyRejectionThreshold?: number;
}

export class ToyotaClient {
  private session?: Session;
  private inflight?: Promise<Session>;
  /** mtime of the session file as this client last read or wrote it. */
  private seenMtime?: number;
  private lastForcedRefreshAt?: number;
  /** Consecutive requests refused even with a freshly refreshed token. */
  private keyRejections = 0;
  private readonly forcedRefreshCooldownMs: number;
  private readonly keyRejectionThreshold: number;

  constructor(
    private readonly config: ToyotaConfig,
    private readonly auth: ToyotaAuth,
    private readonly store: FileStore<Session>,
    private readonly fetchFn: FetchFn,
    private readonly log: ClientLogger,
    private readonly now: () => number = Date.now,
    options: ClientOptions = {},
  ) {
    this.forcedRefreshCooldownMs = options.forcedRefreshCooldownMs ?? FORCED_REFRESH_COOLDOWN_MS;
    this.keyRejectionThreshold = options.keyRejectionThreshold ?? KEY_REJECTION_THRESHOLD;
  }

  /** Returns a usable session, refreshing or signing in at most once at a time. */
  async ensureSession(forceRefresh = false): Promise<Session> {
    this.inflight ??= this.resolveSession(forceRefresh).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /**
   * True when the session file was written by someone else (the settings UI
   * after a sign-in) since this client last read or wrote it.
   */
  sessionFileChanged(): boolean {
    const mtime = this.store.mtimeMs();
    return mtime !== undefined && mtime !== this.seenMtime;
  }

  private async resolveSession(forceRefresh: boolean): Promise<Session> {
    let session = this.session;
    if (!session || this.sessionFileChanged()) {
      const mtime = this.store.mtimeMs();
      const stored = this.store.load();
      this.seenMtime = mtime;
      if (stored && stored.username.toLowerCase() === this.config.username.toLowerCase()) {
        session = stored;
        this.session = stored;
      }
    }
    if (session && !forceRefresh && !requiresRefresh(session, this.now())) {
      this.session = session;
      return session;
    }
    if (session) {
      try {
        const refreshed = await this.auth.refresh(session);
        return this.accept(refreshed);
      } catch (error) {
        if (!(error instanceof AuthHttpError) || !error.isRefreshTokenRejection) {
          throw error;
        }
        this.log.warn('Saved Toyota sign-in was rejected; signing in again.');
        this.store.clear();
        this.session = undefined;
      }
    }
    const signedIn = await this.auth.signIn({
      username: this.config.username,
      password: this.config.password,
      otp: this.config.oneTimePasscode,
    });
    return this.accept(signedIn);
  }

  private accept(session: Session): Session {
    this.session = session;
    // Refresh tokens rotate on every use, so persist before anything else.
    try {
      this.store.save(session);
      this.seenMtime = this.store.mtimeMs();
    } catch (error) {
      this.log.warn(`Could not save the Toyota session to disk: ${String(error)}`);
    }
    return session;
  }

  /** One request, with a single refresh-and-retry on 401/403. */
  async send(makeRoute: (session: Session) => Route, vin: string, generation: Generation): Promise<Envelope> {
    return this.withAuthRetry((session) => this.sendOnce(makeRoute(session), session, vin, generation));
  }

  /**
   * Runs a request; on 401/403 refreshes the token once and retries once.
   * Toyota answers transient 403s while its gateway is unhealthy, so forced
   * refreshes are rate limited (each one hits the sign-in server, which answers
   * 429 when hammered), and a 403 that survives a fresh token is only blamed on
   * the client key after it has happened several times in a row.
   */
  private async withAuthRetry<T>(run: (session: Session) => Promise<T>): Promise<T> {
    try {
      const result = await run(await this.ensureSession());
      this.keyRejections = 0;
      return result;
    } catch (error) {
      if (!(error instanceof ApiHttpError) || !error.isAuthFailure) {
        throw error;
      }
      if (this.lastForcedRefreshAt !== undefined && this.now() - this.lastForcedRefreshAt < this.forcedRefreshCooldownMs) {
        this.log.debug(`Toyota answered HTTP ${error.status}; the token was refreshed moments ago, so not refreshing again yet.`);
        throw error;
      }
    }
    this.lastForcedRefreshAt = this.now();
    try {
      const result = await run(await this.ensureSession(true));
      this.keyRejections = 0;
      return result;
    } catch (error) {
      if (error instanceof ApiHttpError && error.isAuthFailure) {
        this.keyRejections++;
        if (this.keyRejections >= this.keyRejectionThreshold) {
          throw new ClientKeyRejectedError();
        }
      }
      throw error;
    }
  }

  private async sendOnce(route: Route, session: Session, vin: string, generation: Generation): Promise<Envelope> {
    const headers = buildHeaders(
      { apiKey: this.config.apiKey, appVersion: this.config.appVersion, session, vin, generation },
      route,
    );
    const body = route.body === undefined ? undefined : JSON.stringify(route.body);
    if (route.method !== 'GET') {
      // Header names and the redacted body only, so a refused command can be compared with RedLink's request.
      this.log.debug(`${route.method} ${route.path} headers [${Object.keys(headers).sort().join(', ')}] body ${redact(body ?? '')}`);
    }
    const response = await this.fetchFn(routeUrl(route), {
      method: route.method,
      headers,
      body,
      signal: AbortSignal.timeout(route.method === 'GET' ? 20_000 : 60_000),
    });
    return this.readEnvelope(response, route);
  }

  private async readEnvelope(response: Response, route: Route): Promise<Envelope> {
    const text = await response.text();
    if (!response.ok) {
      if (route.method !== 'GET') {
        this.log.debug(`${route.method} ${route.path} answered HTTP ${response.status}: ${redact(text).slice(0, 500)}`);
      }
      throw new ApiHttpError(response.status, text);
    }
    const envelope = parseEnvelope(text);
    const rejection = findRejection(envelope);
    if (rejection) {
      throw new OperationRejectedError(rejection.code, rejection.message);
    }
    return envelope;
  }

  /** 24MM remote commands go through AppSync GraphQL. */
  async sendGraphQLCommand(command: RemoteCommand, vin: string): Promise<Envelope> {
    const graphqlKey = this.config.graphqlApiKey;
    if (!graphqlKey) {
      throw new UnsupportedError('24MM remote commands need "graphqlApiKey" in the plugin config.');
    }
    const run = async (session: Session): Promise<Envelope> => {
      const response = await this.fetchFn(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': graphqlKey,
          'x-resolver-api-key': this.config.apiKey,
          authorization: `Bearer ${session.accessToken}`,
          vin,
          'x-guid': session.guid,
          'x-deviceid': session.deviceId,
          'x-appbrand': 'T',
          'x-channel': 'ONEAPP',
          'x-appversion': this.config.appVersion,
          'user-agent': 'homebridge-toyota',
        },
        body: JSON.stringify({
          operationName: 'SendRemoteCommand',
          query: GRAPHQL_COMMAND,
          variables: { command, autoFixCommands: [] },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new ApiHttpError(response.status, text);
      }
      const parsed: unknown = JSON.parse(text);
      const errors = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['errors'] : undefined;
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0] as Record<string, unknown> | undefined;
        const unauthorized = /unauthor|forbidden|not authorized/i.test(JSON.stringify(first ?? {}));
        if (unauthorized) {
          throw new ApiHttpError(403, text);
        }
        throw new OperationRejectedError(undefined, typeof first?.['message'] === 'string' ? first['message'] : undefined);
      }
      const envelope = parseEnvelope(text);
      const rejection = findRejection(envelope);
      if (rejection) {
        throw new OperationRejectedError(rejection.code, rejection.message);
      }
      return envelope;
    };
    return this.withAuthRetry(run);
  }
}

const GRAPHQL_COMMAND = `mutation SendRemoteCommand($command: String!, $autoFixCommands: [String]!) {
  executeRemoteCommand(commandInputBody: { command: $command, autofixCommands: $autoFixCommands }) {
    payload { requestNo correlationId returnCode }
    status { messages { responseCode description detailedDescription } }
  }
}`;
