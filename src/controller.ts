import { ApiHttpError, ClientKeyRejectedError, UnsupportedError } from './client';
import { classifyError, type VehicleApi, type VehicleCommand } from './api';
import type { ElectricStatus, Generation, PrepareCapabilities, RemoteStatus } from './parse';
import type { PollOutcome } from './poller';
import { lockCommandConfirmed } from './state';

export interface VehicleState {
  status?: RemoteStatus;
  electric?: ElectricStatus;
  /** Engine (or climate on an EV) running. */
  running?: boolean;
}

export interface ControllerListener {
  stateChanged(state: VehicleState): void;
  /** A command failed or was not confirmed; HomeKit targets should return to reported state. */
  commandFailed(command: VehicleCommand, reason: string): void;
}

export interface ControllerLog {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export interface ControllerOptions {
  remoteStart: boolean;
  exposeBattery: boolean;
  /** When set, Remote Start first prepares the vehicle using the commands this vehicle supports. */
  prepare?: PrepareCapabilities;
  /** Pauses between verification reads after a command. */
  verifyDelaysMs?: number[];
  /** True when Toyota's vehicle record says the vehicle is an EV or plug-in hybrid. */
  electricHint?: boolean;
  /**
   * Ask the vehicle for a fresh report once its last one is this old, at most
   * once per this interval (RedLink's stale-report wake). 0 or unset: never.
   */
  staleReportMs?: number;
  /** Remembers the last wake across restarts, so a restart does not wake the car again. */
  wakeStore?: WakeStore;
  /** Pauses between status reads while waiting for the fresh report. */
  wakeWaitDelaysMs?: number[];
  /**
   * Looking at the vehicle in the Home app asks for a fresh report once the
   * last one is this old and no wake went out within it (RedLink's app-open
   * wake, 15 minutes). 0 or unset: never.
   */
  interestWakeMs?: number;
  /** Something just happened (a command, a wake, the engine running): poll closely for a while. */
  onActivity?: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WakeStore {
  load(): number | undefined;
  save(wokeAt: number): void;
}

/**
 * Six reads, 10 seconds apart. OneApp uses 3 x 10 s, but a 21MM bZ has taken
 * 31 seconds to report a lock (2026-11-16), and an unconfirmed lock abandons
 * Remote Start. The reads are cheap cached GETs.
 */
export const DEFAULT_VERIFY_DELAYS_MS = [10_000, 10_000, 10_000, 10_000, 10_000, 10_000];
/** At most this many Home-app wakes in any 24 hours, in case a home hub reads the lock on its own. */
export const MAX_INTEREST_WAKES_PER_DAY = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A parked car takes a while to wake and upload; about two minutes, then the next poll picks it up. */
export const DEFAULT_WAKE_WAIT_DELAYS_MS = [20_000, 20_000, 20_000, 30_000, 30_000];
const PARK_MS = 12 * 60 * 60 * 1000;
const STATUS_RETRY_MS = 5_000;
const FORBIDDEN_BEFORE_PARK = 3;

const severity: Record<PollOutcome, number> = { ok: 0, failed: 1, rateLimited: 2, fatal: 3 };

export class VehicleController {
  readonly state: VehicleState = {};
  private pending?: VehicleCommand;
  private electricParkedUntil = 0;
  /** Consecutive 403s from the EV endpoint; one alone can be a passing outage. */
  private electricRefusals = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly delays: number[];
  private lastWake?: number;
  private refreshUnsupported = false;
  private waking = false;
  private interestWakes: number[] = [];

  constructor(
    readonly vin: string,
    private readonly generation: Generation,
    private readonly api: VehicleApi,
    private readonly options: ControllerOptions,
    private readonly listener: ControllerListener,
    private readonly log: ControllerLog,
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.delays = options.verifyDelaysMs ?? DEFAULT_VERIFY_DELAYS_MS;
  }

  get commandPending(): boolean {
    return this.pending !== undefined;
  }

  /** EV evidence: a real charge reading beats the record hint. */
  get electricLike(): boolean {
    return this.state.electric?.batteryPercent !== undefined || this.options.electricHint === true;
  }

  /** One cached-data poll. Never throws. Reads are cheap GETs and never wake the vehicle. */
  async poll(): Promise<PollOutcome> {
    let worst: PollOutcome = 'ok';
    const note = (error: unknown, what: string): void => {
      const outcome = classifyError(error);
      if (severity[outcome] > severity[worst]) {
        worst = outcome;
      }
      this.log.debug(`${what} failed: ${describe(error)}`);
      this.lastError = `${what}: ${describe(error)}`;
    };

    try {
      this.state.status = await this.api.readStatus(this.vin, this.generation);
    } catch (error) {
      note(error, 'status read');
      this.emit();
      return worst;
    }

    if (this.options.exposeBattery && this.now() >= this.electricParkedUntil) {
      try {
        this.state.electric = await this.api.readElectric(this.vin, this.generation);
        this.electricRefusals = 0;
      } catch (error) {
        const refusal = endpointRefusal(error);
        if (refusal === 'permanent' || (refusal === 'forbidden' && ++this.electricRefusals >= FORBIDDEN_BEFORE_PARK)) {
          this.electricParkedUntil = this.now() + PARK_MS;
          this.electricRefusals = 0;
          this.log.debug('EV status is not available for this vehicle; not asking again for 12 hours.');
        } else if (refusal === 'forbidden') {
          this.log.debug(`EV status read refused (${describe(error)}); not parking it yet, since Toyota also answers 403 during outages.`);
        } else {
          note(error, 'EV status read');
        }
      }
    }

    if (this.options.remoteStart && worst === 'ok') {
      try {
        this.state.running = await this.api.readRunning(this.vin, this.generation, this.electricLike);
      } catch (error) {
        note(error, 'engine status read');
      }
    }

    this.emit();
    if (this.state.running === true) {
      this.activity();
    }
    if (worst === 'ok') {
      worst = await this.refreshIfStale();
    }
    return worst;
  }

  lastError?: string;

  /**
   * Toyota serves the vehicle's last upload, which can be hours old on a parked
   * car. When it is older than `staleReportMs` and no wake went out within that
   * time, ask the vehicle for a fresh report and wait briefly for it. A wake
   * that RedLink or the Toyota app sent shows up as a fresh report, so this
   * plugin does not add its own on top. Never throws.
   */
  private async refreshIfStale(): Promise<PollOutcome> {
    const staleMs = this.options.staleReportMs ?? 0;
    if (staleMs <= 0 || !this.wakeAllowed(staleMs)) {
      return 'ok';
    }
    return this.wake(staleMs);
  }

  /**
   * The Home app is showing this vehicle (HomeKit read the lock). Ask for a
   * fresh report in the background when the last one is older than
   * `interestWakeMs`, within a daily cap. Returns at once.
   */
  noteInterest(): void {
    const minimumMs = this.options.interestWakeMs ?? 0;
    if (minimumMs <= 0 || !this.wakeAllowed(minimumMs)) {
      return;
    }
    const now = this.now();
    this.interestWakes = this.interestWakes.filter((t) => now - t < DAY_MS);
    if (this.interestWakes.length >= MAX_INTEREST_WAKES_PER_DAY) {
      return;
    }
    this.interestWakes.push(now);
    void this.wake(minimumMs, 'The Home app is showing the vehicle');
  }

  /** True when the report is at least `minimumMs` old and no wake went out within it. */
  private wakeAllowed(minimumMs: number): boolean {
    const status = this.state.status;
    if (this.refreshUnsupported || this.pending || this.waking || !status) {
      return false;
    }
    const now = this.now();
    if (status.reportedAtMs !== undefined && now - status.reportedAtMs < minimumMs) {
      return false;
    }
    this.lastWake ??= this.options.wakeStore?.load();
    return !(this.lastWake !== undefined && now - this.lastWake >= 0 && now - this.lastWake < minimumMs);
  }

  /** Sends refresh-status and waits briefly for the newer report. Never throws. */
  private async wake(retryMs: number, reason?: string): Promise<PollOutcome> {
    this.waking = true;
    try {
      return await this.wakeOnce(retryMs, reason);
    } catch (error) {
      this.log.warn(`Unexpected error while asking for a fresh report: ${describe(error)}`);
      return 'ok';
    } finally {
      this.waking = false;
    }
  }

  private async wakeOnce(retryMs: number, reason?: string): Promise<PollOutcome> {
    const now = this.now();
    const reportedAtMs = this.state.status?.reportedAtMs;
    // Recorded before sending, so a failure or a crash still waits a full interval.
    this.lastWake = now;
    try {
      this.options.wakeStore?.save(now);
    } catch (error) {
      this.log.debug(`Could not save the wake time: ${describe(error)}`);
    }
    const age = reportedAtMs === undefined ? 'has no report time' : `is ${formatAge(now - reportedAtMs)} old`;
    const retry = formatAge(retryMs);
    this.log.info(`${reason ? `${reason} and its` : "The vehicle's"} last report ${age}; asking it for a fresh one.`);
    try {
      await this.api.requestRefresh(this.vin, this.generation);
    } catch (error) {
      if (error instanceof UnsupportedError) {
        this.refreshUnsupported = true;
        this.log.info(`${describe(error)} Lock state will be as fresh as the vehicle's own reports.`);
        return 'ok';
      }
      this.log.warn(`Toyota refused the request for a fresh report: ${describe(error)} Trying again in ${retry} at the earliest.`);
      const outcome = classifyError(error);
      return outcome === 'rateLimited' ? outcome : 'ok';
    }
    this.activity();
    for (const delay of this.options.wakeWaitDelaysMs ?? DEFAULT_WAKE_WAIT_DELAYS_MS) {
      await this.sleep(delay);
      let fresh: RemoteStatus;
      try {
        fresh = await this.api.readStatus(this.vin, this.generation);
      } catch (error) {
        if (classifyError(error) !== 'failed') {
          break;
        }
        this.log.debug(`Read while waiting for a fresh report failed; trying again: ${describe(error)}`);
        continue;
      }
      if (fresh.reportedAtMs !== undefined && (reportedAtMs === undefined || fresh.reportedAtMs > reportedAtMs)) {
        this.state.status = fresh;
        this.emit();
        this.log.info(`The vehicle sent a fresh report (${fresh.reportedAt ?? 'no report time'}).`);
        return 'ok';
      }
    }
    this.log.info(`The vehicle has not sent a fresh report yet; a later poll will show it if it arrives. Next request in ${retry} at the earliest.`);
    return 'ok';
  }

  private activity(): void {
    try {
      this.options.onActivity?.();
    } catch (error) {
      this.log.debug(`Could not speed up polling: ${describe(error)}`);
    }
  }

  /**
   * Sends a command, then re-reads cached status a bounded number of times to confirm.
   * Remote Start first prepares the vehicle (see prepareForStart) when enabled.
   */
  async command(command: VehicleCommand): Promise<void> {
    if (this.pending === command) {
      // A repeated tap or Siri retry: the running attempt already answers it.
      this.log.debug(`Ignoring a repeated ${command}: it is already in progress.`);
      return;
    }
    if (this.pending) {
      this.log.warn(`Ignoring ${command}: ${this.pending} is still in progress.`);
      this.listener.commandFailed(command, 'another command is in progress');
      return;
    }
    this.pending = command;
    try {
      if (command === 'remoteStart' && this.options.prepare) {
        const blocked = await this.prepareForStart(this.options.prepare);
        if (blocked) {
          this.log.warn(`Remote start was not sent: ${blocked}.`);
          this.pending = undefined;
          this.emit();
          this.listener.commandFailed(command, blocked);
          return;
        }
      }
      const failure = await this.sendAndConfirm(command, true);
      if (failure) {
        this.listener.commandFailed(command, failure);
      }
    } finally {
      this.pending = undefined;
      this.activity();
    }
  }

  /**
   * Sends one command and confirms it from the vehicle's next reports (see
   * DEFAULT_VERIFY_DELAYS_MS). Returns undefined when confirmed, else why not.
   * `last` is true for the user's own command: it then ends the pending state
   * before the final state is published so HomeKit settles on what was reported.
   */
  private async sendAndConfirm(command: VehicleCommand, last: boolean): Promise<string | undefined> {
    try {
      await this.api.sendCommand(command, this.vin, this.generation, this.electricLike);
    } catch (error) {
      this.log.warn(`${command} failed: ${describe(error)}`);
      return describe(error);
    }
    this.log.info(`${command} accepted by Toyota; waiting for the vehicle to report.`);
    const settle = (): void => {
      if (last) {
        this.pending = undefined;
      }
      this.emit();
    };
    let readError: unknown;
    for (const delay of this.delays) {
      await this.sleep(delay);
      try {
        if (readsStatus(command)) {
          this.state.status = await this.api.readStatus(this.vin, this.generation);
        } else {
          this.state.running = await this.api.readRunning(this.vin, this.generation, this.electricLike);
        }
        readError = undefined;
      } catch (error) {
        // One failed read (Toyota answers 500/503 in bursts) should not abandon
        // an accepted command; a rate limit or sign-in problem should.
        readError = error;
        if (classifyError(error) !== 'failed') {
          break;
        }
        this.log.debug(`Read while confirming ${command} failed; trying again: ${describe(error)}`);
        continue;
      }
      if (this.confirmed(command)) {
        settle();
        this.log.info(`${command} confirmed.`);
        return undefined;
      }
    }
    if (readError !== undefined) {
      this.log.warn(`Could not confirm ${command}: ${describe(readError)}`);
      settle();
      return describe(readError);
    }
    this.log.warn(`${command} was accepted but the vehicle has not reported the change yet; showing its last report.`);
    settle();
    return 'not confirmed by the vehicle yet';
  }

  /**
   * Makes the vehicle ready for Remote Start, one step at a time, each decided
   * from a fresh status read and confirmed from the next one, so a step the
   * vehicle already satisfies is skipped and a repeat run changes nothing.
   * Returns undefined when it is safe to start, else the reason it is not.
   */
  private async prepareForStart(capabilities: PrepareCapabilities): Promise<string | undefined> {
    try {
      this.state.status = await this.readStatusRetryingOnce();
    } catch (error) {
      return `could not read the vehicle status first (${describe(error)})`;
    }
    this.emit();

    const steps: PrepareStep[] = [
      {
        label: 'lock the doors',
        command: 'lock',
        needed: (s) => s.doorsLocked === false,
        supported: true,
      },
      {
        label: 'close the windows',
        command: 'closeWindows',
        needed: (s) => s.openings.some((o) => o.kind === 'window' && o.open === true),
        supported: capabilities.closeWindows,
      },
      {
        label: 'close the moonroof',
        command: 'closeMoonroof',
        needed: (s) => s.openings.some((o) => o.kind === 'roof' && o.open === true),
        supported: capabilities.closeMoonroof,
      },
      {
        label: 'lock the hatch',
        command: 'lockTrunk',
        needed: (s) => s.openings.some((o) => o.kind === 'trunk' && o.locked === false),
        supported: capabilities.lockTrunk,
      },
    ];

    for (let index = 0; index <= steps.length; index++) {
      const status = this.state.status;
      if (!status) {
        return 'the vehicle status is not available';
      }
      const open = status.openings.filter((o) => (o.kind === 'door' || o.kind === 'hood' || o.kind === 'trunk') && o.open === true);
      if (open.length > 0) {
        return `${open.map((o) => o.label).join(', ')} ${open.length === 1 ? 'is' : 'are'} open`;
      }
      const step = steps[index];
      if (!step) {
        return undefined;
      }
      if (!step.needed(status)) {
        continue;
      }
      if (!step.supported) {
        this.log.warn(`Remote start will go ahead, but this vehicle does not report a remote command to ${step.label}.`);
        continue;
      }
      this.log.info(`Remote start: preparing the vehicle, step: ${step.label}.`);
      const failure = await this.sendAndConfirm(step.command, false);
      if (failure) {
        return `could not ${step.label} first (${failure})`;
      }
    }
    return undefined;
  }

  /** A transient 500/503 gets one more try after a short pause; anything else fails at once. */
  private async readStatusRetryingOnce(): Promise<RemoteStatus> {
    try {
      return await this.api.readStatus(this.vin, this.generation);
    } catch (error) {
      if (classifyError(error) !== 'failed') {
        throw error;
      }
      this.log.debug(`Status read failed; trying once more: ${describe(error)}`);
      await this.sleep(STATUS_RETRY_MS);
      return this.api.readStatus(this.vin, this.generation);
    }
  }

  private confirmed(command: VehicleCommand): boolean {
    const openings = this.state.status?.openings ?? [];
    switch (command) {
      case 'lock':
        return lockCommandConfirmed(true, this.state.status?.doorsLocked ?? null);
      case 'unlock':
        return lockCommandConfirmed(false, this.state.status?.doorsLocked ?? null);
      case 'remoteStart':
        return this.state.running === true;
      case 'remoteStop':
        return this.state.running === false;
      case 'closeWindows':
        return openings.every((o) => o.kind !== 'window' || o.open !== true);
      case 'closeMoonroof':
        return openings.every((o) => o.kind !== 'roof' || o.open !== true);
      case 'lockTrunk':
        return openings.every((o) => o.kind !== 'trunk' || o.locked !== false);
      case 'unlockTrunk':
        return openings.some((o) => o.kind === 'trunk' && o.locked === false);
    }
  }

  private emit(): void {
    try {
      this.listener.stateChanged(this.state);
    } catch (error) {
      this.log.warn(`Could not update HomeKit: ${describe(error)}`);
    }
  }
}

interface PrepareStep {
  label: string;
  command: VehicleCommand;
  needed: (status: RemoteStatus) => boolean;
  supported: boolean;
}

/** Everything but the engine and climate commands is confirmed from the status report. */
function readsStatus(command: VehicleCommand): boolean {
  return command !== 'remoteStart' && command !== 'remoteStop';
}

/** 400 and 404 describe the endpoint itself; a 403 only does when it keeps happening. */
function endpointRefusal(error: unknown): 'permanent' | 'forbidden' | undefined {
  if (error instanceof ApiHttpError && (error.status === 400 || error.status === 404)) {
    return 'permanent';
  }
  if (error instanceof ClientKeyRejectedError || (error instanceof ApiHttpError && error.status === 403)) {
    return 'forbidden';
  }
  return undefined;
}

/** "40 minutes", "3.2 hours". */
export function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${(ms / 3_600_000).toFixed(1)} hours`;
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
