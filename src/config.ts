import { GENERATIONS, type Generation } from './parse';
import { DEFAULT_APP_VERSION } from './settings';
import { DEFAULT_AUTO_LOCK_MINUTES } from './autolock';

export const MIN_POLL_MINUTES = 5;
export const DEFAULT_POLL_MINUTES = 5;
export const MAX_POLL_MINUTES = 24 * 60;
/** RedLink's stale-report interval; also the shortest allowed, to protect the 12 V battery. */
export const DEFAULT_STALE_REPORT_HOURS = 3;
export const MIN_STALE_REPORT_HOURS = 3;
export const MAX_STALE_REPORT_HOURS = 48;

export interface ToyotaConfig {
  username: string;
  password: string;
  /** Toyota OneApp public client key (X-API-KEY). Supplied by the user, never bundled. */
  apiKey: string;
  oneTimePasscode?: string;
  /** Limit to one vehicle. Default: every vehicle on the account. */
  vin?: string;
  /** Override Toyota's reported generation (17CY, 17CYPLUS, 21MM, 24MM). */
  generation?: Generation;
  pollIntervalMinutes: number;
  /** Ask the vehicle for a fresh report once its last one is this many hours old. 0 = never. */
  staleReportHours: number;
  /** Opening the vehicle in the Home app asks for a fresh report when the last one is 15+ minutes old. */
  wakeOnHomeAppOpen: boolean;
  /** Minutes the doors must be reported unlocked, with the car parked and closed, before auto-lock locks them. Undefined: off. */
  autoLockMinutes?: number;
  exposeOpenings: boolean;
  exposeBattery: boolean;
  remoteStartEnabled: boolean;
  /** Lock, close and check the vehicle before Remote Start. On unless `remoteStart.prepare` is false. */
  remoteStartPrepare: boolean;
  /** AppSync key, only needed for 24MM remote commands. */
  graphqlApiKey?: string;
  appVersion: string;
}

export interface ConfigResult {
  config?: ToyotaConfig;
  errors: string[];
  warnings: string[];
}

function optString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function parseConfig(raw: Record<string, unknown>): ConfigResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const username = optString(raw['username']);
  const password = typeof raw['password'] === 'string' && raw['password'] !== '' ? raw['password'] : undefined;
  const apiKey = optString(raw['apiKey']);
  if (!username) {
    errors.push('"username" (Toyota account email) is required.');
  }
  if (!password) {
    errors.push('"password" is required.');
  }
  if (!apiKey) {
    errors.push('"apiKey" (Toyota OneApp client key) is required. See the README for how to obtain it.');
  }

  let generation: Generation | undefined;
  const rawGeneration = optString(raw['generation']);
  if (rawGeneration) {
    generation = GENERATIONS.find((g) => g === rawGeneration.toUpperCase());
    if (!generation) {
      errors.push(`"generation" must be one of ${GENERATIONS.join(', ')}.`);
    }
  }

  let pollIntervalMinutes = DEFAULT_POLL_MINUTES;
  if (raw['pollIntervalMinutes'] !== undefined) {
    const n = Number(raw['pollIntervalMinutes']);
    if (!Number.isFinite(n)) {
      warnings.push(`"pollIntervalMinutes" is not a number; using ${DEFAULT_POLL_MINUTES}.`);
    } else if (n < MIN_POLL_MINUTES) {
      warnings.push(`"pollIntervalMinutes" below ${MIN_POLL_MINUTES} is not allowed; using ${MIN_POLL_MINUTES}.`);
      pollIntervalMinutes = MIN_POLL_MINUTES;
    } else {
      pollIntervalMinutes = Math.min(Math.floor(n), MAX_POLL_MINUTES);
    }
  }

  let staleReportHours = DEFAULT_STALE_REPORT_HOURS;
  if (raw['staleReportHours'] !== undefined) {
    const n = Number(raw['staleReportHours']);
    if (!Number.isFinite(n) || n < 0) {
      warnings.push(`"staleReportHours" must be 0 or a number of hours; using ${DEFAULT_STALE_REPORT_HOURS}.`);
    } else if (n === 0) {
      staleReportHours = 0;
    } else if (n < MIN_STALE_REPORT_HOURS) {
      warnings.push(`"staleReportHours" below ${MIN_STALE_REPORT_HOURS} is not allowed (each request wakes the car); using ${MIN_STALE_REPORT_HOURS}.`);
      staleReportHours = MIN_STALE_REPORT_HOURS;
    } else {
      staleReportHours = Math.min(n, MAX_STALE_REPORT_HOURS);
    }
  }

  let autoLockMinutes: number | undefined;
  const autoLock = raw['autoLock'];
  if (typeof autoLock === 'object' && autoLock !== null && (autoLock as Record<string, unknown>)['enabled'] === true) {
    const rawMinutes = (autoLock as Record<string, unknown>)['afterMinutes'];
    const n = rawMinutes === undefined ? DEFAULT_AUTO_LOCK_MINUTES : Number(rawMinutes);
    if (!Number.isFinite(n) || n < 1) {
      warnings.push(`"autoLock.afterMinutes" must be at least 1; using ${DEFAULT_AUTO_LOCK_MINUTES}.`);
      autoLockMinutes = DEFAULT_AUTO_LOCK_MINUTES;
    } else {
      autoLockMinutes = Math.min(n, 24 * 60);
    }
  }

  const remoteStart = raw['remoteStart'];
  const remoteStartEnabled =
    typeof remoteStart === 'object' && remoteStart !== null && (remoteStart as Record<string, unknown>)['enabled'] === true;

  const remoteStartPrepare =
    !(typeof remoteStart === 'object' && remoteStart !== null) || (remoteStart as Record<string, unknown>)['prepare'] !== false;

  if (errors.length > 0 || !username || !password || !apiKey) {
    return { errors, warnings };
  }
  return {
    errors,
    warnings,
    config: {
      username,
      password,
      apiKey,
      oneTimePasscode: optString(raw['oneTimePasscode']),
      vin: optString(raw['vin'])?.toUpperCase(),
      generation,
      pollIntervalMinutes,
      staleReportHours,
      wakeOnHomeAppOpen: raw['wakeOnHomeAppOpen'] !== false,
      autoLockMinutes,
      exposeOpenings: raw['exposeOpenings'] !== false,
      exposeBattery: raw['exposeBattery'] !== false,
      remoteStartEnabled,
      remoteStartPrepare,
      graphqlApiKey: optString(raw['graphqlApiKey']),
      appVersion: optString(raw['appVersion']) ?? DEFAULT_APP_VERSION,
    },
  };
}
