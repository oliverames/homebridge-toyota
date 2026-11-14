import { AuthHttpError, type FetchFn, type ToyotaAuth } from './auth';
import type { ToyotaConfig } from './config';
import { type Envelope, findRejection, parseEnvelope } from './envelope';
import type { Generation } from './parse';
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
    super(`Toyota rejected the request${code ? ` (${code})` : ''}: ${message ?? 'the vehicle did not accept it'}`);
  }
}

/** A second 403 right after a successful token refresh points at the client key, not the login. */
export class ClientKeyRejectedError extends Error {
  constructor() {
    super(
      'Toyota rejected every request after a fresh sign-in. The "apiKey" client key has most likely been rotated; update it in the plugin config.',
    );
  }
}

export class UnsupportedError extends Error {}

function detail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const message = (parsed as Record<string, unknown>)['message'] ?? (parsed as Record<string, unknown>)['description'];
      if (typeof message === 'string' && message.trim() !== '') {
        return `: ${message.trim().slice(0, 200)}`;
      }
    }
  } catch {
    // not JSON
  }
  return '';
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
    'x-correlationid': ctx.correlationId ?? crypto.randomUUID(),
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
  electricStatus: (version: 'v3' | 'v2' = 'v3'): Route => ({ method: 'GET', path: `${version}/electric/status` }),
  /** Lock/unlock/engine-start/engine-stop on every generation except 24MM (GraphQL). */
  remoteCommand: (command: RemoteCommand, g: Generation, session: Session, vin: string): Route => {
    if (g === '17CY') {
      const [code, value] = LEGACY_CODES[command];
      return {
        method: 'POST',
        path: 'v1/legacy/remote/command',
        body: { command: { code, value }, guid: session.guid, deviceId: session.deviceId, deviceType: 'iOS', vin },
      };
    }
    return { method: 'POST', path: 'v1/global/remote/command', body: { command, autoFixPopup: false } };
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

export type RemoteCommand = 'door-lock' | 'door-unlock' | 'engine-start' | 'engine-stop';

const LEGACY_CODES: Record<RemoteCommand, [string, number]> = {
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

export class ToyotaClient {
  private session?: Session;
  private inflight?: Promise<Session>;
  /** mtime of the session file as this client last read or wrote it. */
  private seenMtime?: number;

  constructor(
    private readonly config: ToyotaConfig,
    private readonly auth: ToyotaAuth,
    private readonly store: FileStore<Session>,
    private readonly fetchFn: FetchFn,
    private readonly log: ClientLogger,
    private readonly now: () => number = Date.now,
  ) {}

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
    let session = await this.ensureSession();
    try {
      return await this.sendOnce(makeRoute(session), session, vin, generation);
    } catch (error) {
      if (!(error instanceof ApiHttpError) || !error.isAuthFailure) {
        throw error;
      }
    }
    session = await this.ensureSession(true);
    try {
      return await this.sendOnce(makeRoute(session), session, vin, generation);
    } catch (error) {
      if (error instanceof ApiHttpError && error.isAuthFailure) {
        throw new ClientKeyRejectedError();
      }
      throw error;
    }
  }

  private async sendOnce(route: Route, session: Session, vin: string, generation: Generation): Promise<Envelope> {
    const headers = buildHeaders(
      { apiKey: this.config.apiKey, appVersion: this.config.appVersion, session, vin, generation },
      route,
    );
    const response = await this.fetchFn(routeUrl(route), {
      method: route.method,
      headers,
      body: route.body === undefined ? undefined : JSON.stringify(route.body),
      signal: AbortSignal.timeout(route.method === 'GET' ? 20_000 : 60_000),
    });
    return this.readEnvelope(response);
  }

  private async readEnvelope(response: Response): Promise<Envelope> {
    const text = await response.text();
    if (!response.ok) {
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
    try {
      return await run(await this.ensureSession());
    } catch (error) {
      if (!(error instanceof ApiHttpError) || !error.isAuthFailure) {
        throw error;
      }
    }
    try {
      return await run(await this.ensureSession(true));
    } catch (error) {
      if (error instanceof ApiHttpError && error.isAuthFailure) {
        throw new ClientKeyRejectedError();
      }
      throw error;
    }
  }
}

const GRAPHQL_COMMAND = `mutation SendRemoteCommand($command: String!, $autoFixCommands: [String]!) {
  executeRemoteCommand(commandInputBody: { command: $command, autofixCommands: $autoFixCommands }) {
    payload { requestNo correlationId returnCode }
    status { messages { responseCode description detailedDescription } }
  }
}`;
