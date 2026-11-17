import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToyotaVehicleApi } from './api';
import {
  AuthError,
  AuthHttpError,
  type ChallengeStore,
  CHALLENGE_TTL_MS,
  InvalidCredentialsError,
  OtpRejectedError,
  OtpRequiredError,
  type PendingChallenge,
  ToyotaAuth,
  type FetchFn,
} from './auth';
import { ApiHttpError, ClientKeyRejectedError, OperationRejectedError, ToyotaClient } from './client';
import { parseConfig, type ToyotaConfig } from './config';
import { FileStore, isSession, type Session } from './session';
import { PLATFORM_NAME } from './settings';

/** What the platform learned on its last discovery. Contains no secrets. */
export interface VehicleStatus {
  vehicleCount: number;
  checkedAt: number;
}

export function isVehicleStatus(value: unknown): value is VehicleStatus {
  const v = value as Record<string, unknown> | null;
  return typeof v === 'object' && v !== null && typeof v['vehicleCount'] === 'number' && typeof v['checkedAt'] === 'number';
}

/** Everything the settings page may see. Never tokens, passwords, keys or codes. */
export interface UiStatus {
  /** The saved config has an email, password and client key. */
  configured: boolean;
  signedIn: boolean;
  account?: string;
  vehicleCount?: number;
  /** When the session file was last written (sign-in or token refresh), epoch ms. */
  sessionUpdatedAt?: number;
  codePending: boolean;
  /** Assumed expiry of the pending code, epoch ms. */
  codeExpiresAt?: number;
  message?: string;
}

export interface UiResult extends UiStatus {
  outcome: 'signedIn' | 'codeSent' | 'error';
  message: string;
}

export interface SignInServiceOptions {
  storagePath: string;
  configPath: string;
  fetchFn: FetchFn;
  now?: () => number;
}

class MemoryChallenges implements ChallengeStore {
  private pending?: PendingChallenge;
  load(): PendingChallenge | undefined {
    return this.pending;
  }
  save(challenge: PendingChallenge): void {
    this.pending = challenge;
  }
  clear(): void {
    this.pending = undefined;
  }
}

const SILENT = { debug() {}, info() {}, warn() {} };

/** Short, secret-free text for an error. Unknown errors are not echoed. */
function safeMessage(error: unknown): string {
  if (
    error instanceof ApiHttpError ||
    error instanceof ClientKeyRejectedError ||
    error instanceof OperationRejectedError ||
    error instanceof AuthError
  ) {
    return error.message;
  }
  return 'Toyota could not be reached.';
}

/**
 * Sign-in for the Homebridge settings page. Runs in the UI server process, so
 * the pending Toyota challenge lives in memory and the session file is the only
 * thing handed to the platform.
 */
export class SignInService {
  private readonly challenges = new MemoryChallenges();
  private readonly sessions: FileStore<Session>;
  private readonly oldChallengeFile: FileStore<PendingChallenge>;
  private readonly statusFile: FileStore<VehicleStatus>;
  private readonly now: () => number;
  private busy = false;

  constructor(private readonly options: SignInServiceOptions) {
    const dir = join(options.storagePath, 'homebridge-toyota');
    this.sessions = new FileStore<Session>(join(dir, 'session.json'), isSession);
    this.oldChallengeFile = new FileStore<PendingChallenge>(join(dir, 'pending-otp.json'), (v): v is PendingChallenge => typeof v === 'object' && v !== null);
    this.statusFile = new FileStore<VehicleStatus>(join(dir, 'status.json'), isVehicleStatus);
    this.now = options.now ?? Date.now;
  }

  private readConfig(): { config?: ToyotaConfig; problem?: string } {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.options.configPath, 'utf8'));
      const platforms = (parsed as Record<string, unknown> | null)?.['platforms'];
      const entry = Array.isArray(platforms)
        ? platforms.find((p) => typeof p === 'object' && p !== null && (p as Record<string, unknown>)['platform'] === PLATFORM_NAME)
        : undefined;
      if (!entry) {
        return { problem: 'Save the Toyota settings (email, password and client key) first.' };
      }
      const result = parseConfig(entry as Record<string, unknown>);
      if (!result.config) {
        return { problem: `Save the Toyota settings first. ${result.errors.join(' ')}` };
      }
      return { config: result.config };
    } catch {
      return { problem: 'Could not read the Homebridge config. Save the Toyota settings and try again.' };
    }
  }

  status(message?: string): UiStatus {
    const { config } = this.readConfig();
    const session = this.sessions.load();
    const signedIn = session !== undefined && (!config || session.username.toLowerCase() === config.username.toLowerCase());
    const pending = this.pendingChallenge();
    return {
      configured: config !== undefined,
      signedIn,
      account: session?.username,
      vehicleCount: signedIn ? this.statusFile.load()?.vehicleCount : undefined,
      sessionUpdatedAt: session ? this.sessions.mtimeMs() : undefined,
      codePending: pending !== undefined,
      codeExpiresAt: pending ? pending.savedAt + CHALLENGE_TTL_MS : undefined,
      message,
    };
  }

  private pendingChallenge(): PendingChallenge | undefined {
    const pending = this.challenges.load();
    if (pending && this.now() - pending.savedAt >= CHALLENGE_TTL_MS) {
      this.challenges.clear();
      return undefined;
    }
    return pending;
  }

  private result(outcome: UiResult['outcome'], message: string): UiResult {
    return { ...this.status(), outcome, message };
  }

  /** Starts a fresh login with the saved credentials. Toyota emails a code when it wants one. */
  async start(): Promise<UiResult> {
    return this.guarded(async () => {
      const { config, problem } = this.readConfig();
      if (!config) {
        return this.result('error', problem ?? 'The Toyota settings are incomplete.');
      }
      // A fresh login makes Toyota send a new code, so drop any older challenge first.
      this.challenges.clear();
      return this.signIn(config, undefined);
    });
  }

  /** Answers the pending challenge with the emailed code. */
  async verify(code: unknown): Promise<UiResult> {
    return this.guarded(async () => {
      const { config, problem } = this.readConfig();
      if (!config) {
        return this.result('error', problem ?? 'The Toyota settings are incomplete.');
      }
      const otp = typeof code === 'string' ? code.trim() : '';
      if (!/^[A-Za-z0-9]{1,16}$/.test(otp)) {
        return this.result('error', 'Enter the code from the email Toyota sent.');
      }
      if (!this.pendingChallenge()) {
        return this.result('error', 'No code is waiting. Use Sign in / Send code first; a code expires after about 10 minutes.');
      }
      return this.signIn(config, otp);
    });
  }

  private async guarded(run: () => Promise<UiResult>): Promise<UiResult> {
    if (this.busy) {
      return this.result('error', 'Another sign-in step is still running. Wait a moment and try again.');
    }
    this.busy = true;
    try {
      return await run();
    } catch {
      return this.result('error', 'Sign-in failed unexpectedly.');
    } finally {
      this.busy = false;
    }
  }

  private async signIn(config: ToyotaConfig, otp: string | undefined): Promise<UiResult> {
    const auth = new ToyotaAuth(this.options.fetchFn, this.challenges, this.now);
    let session: Session;
    try {
      session = await auth.signIn({ username: config.username, password: config.password, otp });
    } catch (error) {
      if (error instanceof OtpRejectedError) {
        // Toyota either ends the login (the challenge is gone) or shows the prompt again with a new code.
        return this.pendingChallenge()
          ? this.result('codeSent', 'Toyota did not accept that code. A new code was sent; enter the newest one.')
          : this.result('error', 'Toyota did not accept that code. Use Sign in / Send code to get a new one.');
      }
      if (error instanceof OtpRequiredError) {
        return this.result('codeSent', otp ? 'Toyota sent a new code. Enter the newest one.' : 'Code sent. Check your email and enter it below within about 10 minutes.');
      }
      if (error instanceof InvalidCredentialsError) {
        return this.result('error', 'Toyota rejected the email or password. Check the saved settings.');
      }
      if (error instanceof AuthHttpError) {
        return this.result('error', error.status === 429 ? 'Toyota is rate limiting sign-ins. Wait a while before trying again.' : `Toyota sign-in failed (HTTP ${error.status}).`);
      }
      return this.result('error', safeMessage(error));
    }

    this.sessions.save(session);
    this.oldChallengeFile.clear();
    let message = 'Signed in. The plugin picks up the new session on its next update; no restart needed.';
    try {
      const client = new ToyotaClient(config, auth, this.sessions, this.options.fetchFn, SILENT, this.now, { keyRejectionThreshold: 1 });
      const vehicles = (await new ToyotaVehicleApi(client).listVehicles()).filter((v) => !config.vin || v.vin.toUpperCase() === config.vin);
      this.statusFile.save({ vehicleCount: vehicles.length, checkedAt: this.now() });
    } catch (error) {
      message = `Signed in, but the vehicle lookup failed: ${safeMessage(error)}`;
    }
    return this.result('signedIn', message);
  }
}
