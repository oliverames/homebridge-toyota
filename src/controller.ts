import { ApiHttpError, ClientKeyRejectedError } from './client';
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
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Six reads, 10 seconds apart. OneApp uses 3 x 10 s, but a 21MM bZ has taken
 * 31 seconds to report a lock (2026-11-16), and an unconfirmed lock abandons
 * Remote Start. The reads are cheap cached GETs.
 */
export const DEFAULT_VERIFY_DELAYS_MS = [10_000, 10_000, 10_000, 10_000, 10_000, 10_000];
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
    return worst;
  }

  lastError?: string;

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

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
