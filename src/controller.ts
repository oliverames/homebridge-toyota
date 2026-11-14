import { ApiHttpError, ClientKeyRejectedError } from './client';
import { classifyError, type VehicleApi, type VehicleCommand } from './api';
import type { ElectricStatus, Generation, RemoteStatus } from './parse';
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
  /** Pauses between verification reads after a command. OneApp itself uses 3 x 10 s. */
  verifyDelaysMs?: number[];
  /** True when Toyota's vehicle record says the vehicle is an EV or plug-in hybrid. */
  electricHint?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_VERIFY_DELAYS_MS = [10_000, 10_000, 10_000];
const PARK_MS = 12 * 60 * 60 * 1000;

const severity: Record<PollOutcome, number> = { ok: 0, failed: 1, rateLimited: 2, fatal: 3 };

export class VehicleController {
  readonly state: VehicleState = {};
  private pending?: VehicleCommand;
  private electricParkedUntil = 0;
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
      } catch (error) {
        if (isEndpointRefusal(error)) {
          this.electricParkedUntil = this.now() + PARK_MS;
          this.log.debug('EV status is not available for this vehicle; not asking again for 12 hours.');
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

  /** Sends a command, then re-reads cached status a bounded number of times to confirm. */
  async command(command: VehicleCommand): Promise<void> {
    if (this.pending) {
      this.log.warn(`Ignoring ${command}: ${this.pending} is still in progress.`);
      this.listener.commandFailed(command, 'another command is in progress');
      return;
    }
    this.pending = command;
    try {
      try {
        await this.api.sendCommand(command, this.vin, this.generation, this.electricLike);
      } catch (error) {
        this.log.warn(`${command} failed: ${describe(error)}`);
        this.listener.commandFailed(command, describe(error));
        return;
      }
      this.log.info(`${command} accepted by Toyota; waiting for the vehicle to report.`);
      for (const delay of this.delays) {
        await this.sleep(delay);
        try {
          if (isLockCommand(command)) {
            this.state.status = await this.api.readStatus(this.vin, this.generation);
          } else {
            this.state.running = await this.api.readRunning(this.vin, this.generation, this.electricLike);
          }
        } catch (error) {
          this.log.warn(`Could not confirm ${command}: ${describe(error)}`);
          this.pending = undefined;
          this.emit();
          this.listener.commandFailed(command, describe(error));
          return;
        }
        if (this.confirmed(command)) {
          this.pending = undefined;
          this.emit();
          this.log.info(`${command} confirmed.`);
          return;
        }
      }
      this.log.warn(`${command} was accepted but the vehicle has not reported the change yet; showing its last report.`);
      this.pending = undefined;
      this.emit();
      this.listener.commandFailed(command, 'not confirmed by the vehicle yet');
    } finally {
      this.pending = undefined;
    }
  }

  private confirmed(command: VehicleCommand): boolean {
    switch (command) {
      case 'lock':
        return lockCommandConfirmed(true, this.state.status?.doorsLocked ?? null);
      case 'unlock':
        return lockCommandConfirmed(false, this.state.status?.doorsLocked ?? null);
      case 'remoteStart':
        return this.state.running === true;
      case 'remoteStop':
        return this.state.running === false;
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

function isLockCommand(command: VehicleCommand): boolean {
  return command === 'lock' || command === 'unlock';
}

function isEndpointRefusal(error: unknown): boolean {
  return (
    error instanceof ClientKeyRejectedError ||
    (error instanceof ApiHttpError && (error.status === 400 || error.status === 403 || error.status === 404))
  );
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
