import { AuthHttpError, InvalidCredentialsError, OtpRejectedError, OtpRequiredError } from './auth';
import {
  ApiHttpError,
  ClientKeyRejectedError,
  type RemoteCommand,
  routes,
  type ToyotaClient,
} from './client';
import {
  type ElectricStatus,
  type Generation,
  parseClimateRunning,
  parseElectricStatus,
  parseEngineRunning,
  parseRemoteStatus,
  parseTelemetry,
  parseVehicleList,
  recognizesVehicleList,
  type RemoteStatus,
  type Telemetry,
  type VehicleSummary,
} from './parse';
import type { PollOutcome } from './poller';

const PARK_MS = 12 * 60 * 60 * 1000;

export type VehicleCommand = 'lock' | 'unlock' | 'remoteStart' | 'remoteStop' | 'closeWindows' | 'closeMoonroof' | 'lockTrunk' | 'unlockTrunk';

/** The vehicle-facing operations the controller needs; the real one talks to Toyota. */
export interface VehicleApi {
  listVehicles(): Promise<VehicleSummary[]>;
  readStatus(vin: string, generation: Generation): Promise<RemoteStatus>;
  readElectric(vin: string, generation: Generation): Promise<ElectricStatus>;
  /** Engine (or climate, for EVs) running state, when Toyota reports it. */
  readRunning(vin: string, generation: Generation, electric: boolean): Promise<boolean | undefined>;
  sendCommand(command: VehicleCommand, vin: string, generation: Generation, electric: boolean): Promise<void>;
  /** Asks the vehicle to upload a fresh status report. Wakes the car; callers ration it. */
  requestRefresh(vin: string, generation: Generation): Promise<void>;
  /** Asks the vehicle for a fresh EV snapshot. Wakes the car; callers ration it. */
  requestElectricRefresh(vin: string, generation: Generation): Promise<void>;
  /** Speed and its report time, used to tell that the vehicle is parked. */
  readTelemetry(vin: string, generation: Generation): Promise<Telemetry>;
}

export class ToyotaVehicleApi implements VehicleApi {
  constructor(
    private readonly client: ToyotaClient,
    private readonly now: () => number = Date.now,
  ) {}

  async listVehicles(): Promise<VehicleSummary[]> {
    const envelope = await this.client.send(() => routes.vehicles(), '', '21MM');
    if (!recognizesVehicleList(envelope.data)) {
      throw new Error('Toyota returned an unrecognized vehicle list.');
    }
    return parseVehicleList(envelope.data);
  }

  async readStatus(vin: string, generation: Generation): Promise<RemoteStatus> {
    const envelope = await this.client.send(() => routes.status(generation), vin, generation);
    return parseRemoteStatus(envelope.data);
  }

  async readElectric(vin: string, generation: Generation): Promise<ElectricStatus> {
    try {
      return parseElectricStatus((await this.client.send(() => routes.electricStatus('v3'), vin, generation)).data);
    } catch (error) {
      // Same v3 -> v2 fallback RedLink uses; other errors propagate.
      if (error instanceof ApiHttpError && (error.status === 404 || error.status === 400)) {
        return parseElectricStatus((await this.client.send(() => routes.electricStatus('v2'), vin, generation)).data);
      }
      throw error;
    }
  }

  /** Endpoint refusals (403/404) that describe the endpoint, not the moment, are parked for 12 hours. */
  private climateStatusParkedUntil = 0;

  async readRunning(vin: string, generation: Generation, electric: boolean): Promise<boolean | undefined> {
    if (usesClimateRoute(generation, electric) && this.now() >= this.climateStatusParkedUntil) {
      // climate-status answers a steady 403 on some EVs (RedLink parks it), so fall back to engine status.
      try {
        const climate = parseClimateRunning((await this.client.send(() => routes.climateStatus(), vin, generation)).data);
        if (climate !== undefined) {
          return climate;
        }
      } catch (error) {
        const refused =
          error instanceof ClientKeyRejectedError ||
          (error instanceof ApiHttpError && (error.status === 403 || error.status === 404));
        if (!refused) {
          throw error;
        }
        this.climateStatusParkedUntil = this.now() + PARK_MS;
      }
    }
    return parseEngineRunning((await this.client.send(() => routes.engineStatus(generation), vin, generation)).data);
  }

  async requestElectricRefresh(vin: string, generation: Generation): Promise<void> {
    try {
      await this.client.send((s) => routes.electricRefresh(s), vin, generation);
    } catch (error) {
      // RedLink's fallback route when the v2 path is not offered for a vehicle.
      if (error instanceof ApiHttpError && (error.status === 404 || error.status === 400)) {
        await this.client.send((s) => routes.electricRefresh(s, true), vin, generation);
        return;
      }
      throw error;
    }
  }

  async readTelemetry(vin: string, generation: Generation): Promise<Telemetry> {
    return parseTelemetry((await this.client.send(() => routes.telemetry(generation), vin, generation, { authRetry: false })).data);
  }

  async requestRefresh(vin: string, generation: Generation): Promise<void> {
    await this.client.send((s) => routes.refreshStatus(generation, s, vin), vin, generation);
  }

  async sendCommand(command: VehicleCommand, vin: string, generation: Generation, electric: boolean): Promise<void> {
    if (command === 'remoteStart' && usesClimateRoute(generation, electric)) {
      await this.client.send((s) => routes.startClimate(s), vin, generation);
      return;
    }
    if (command === 'remoteStop' && usesClimateRoute(generation, electric)) {
      await this.client.send((s) => routes.stopClimate(s), vin, generation);
      return;
    }
    const remote: RemoteCommand = {
      lock: 'door-lock',
      unlock: 'door-unlock',
      remoteStart: 'engine-start',
      remoteStop: 'engine-stop',
      closeWindows: 'power-window-close',
      closeMoonroof: 'sunroof-close',
      lockTrunk: 'trunk-lock',
      unlockTrunk: 'trunk-unlock',
    }[command] as RemoteCommand;
    if (generation === '24MM') {
      await this.client.sendGraphQLCommand(remote, vin);
      return;
    }
    await this.client.send((s) => routes.remoteCommand(remote, generation, s, vin), vin, generation);
  }
}

/**
 * 21MM EVs start and stop remotely through the shared engine-start/engine-stop remote command.
 * Verified live 2026-11-14 on a 21MM bZ: v2/electric/command startClimate answered a bare HTTP 400
 * from a request identical to RedLink's, while engine-start was accepted and engine-status confirmed
 * it running (pytoyoda reports the same for the bZ4X). The EV climate route stays for other EVs.
 */
export function usesClimateRoute(generation: Generation, electric: boolean): boolean {
  return electric && generation !== '21MM';
}

/** Maps any thrown error to the poll outcome that decides backoff or stopping. */
export function classifyError(error: unknown): PollOutcome {
  if (error instanceof ApiHttpError && error.isRateLimited) {
    return 'rateLimited';
  }
  if (error instanceof AuthHttpError) {
    return error.status === 429 ? 'rateLimited' : 'failed';
  }
  if (error instanceof OtpRequiredError || error instanceof OtpRejectedError || error instanceof InvalidCredentialsError) {
    // OTP required/rejected or invalid credentials: retrying only
    // triggers more passcode texts or risks locking the account.
    return 'fatal';
  }
  return 'failed';
}
