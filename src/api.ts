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
  parseVehicleList,
  recognizesVehicleList,
  type RemoteStatus,
  type VehicleSummary,
} from './parse';
import type { PollOutcome } from './poller';

const PARK_MS = 12 * 60 * 60 * 1000;

export type VehicleCommand = 'lock' | 'unlock' | 'remoteStart' | 'remoteStop';

/** The vehicle-facing operations the controller needs; the real one talks to Toyota. */
export interface VehicleApi {
  listVehicles(): Promise<VehicleSummary[]>;
  readStatus(vin: string, generation: Generation): Promise<RemoteStatus>;
  readElectric(vin: string, generation: Generation): Promise<ElectricStatus>;
  /** Engine (or climate, for EVs) running state, when Toyota reports it. */
  readRunning(vin: string, generation: Generation, electric: boolean): Promise<boolean | undefined>;
  sendCommand(command: VehicleCommand, vin: string, generation: Generation, electric: boolean): Promise<void>;
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
    if (electric && this.now() >= this.climateStatusParkedUntil) {
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

  async sendCommand(command: VehicleCommand, vin: string, generation: Generation, electric: boolean): Promise<void> {
    if (command === 'remoteStart' && electric) {
      await this.client.send((s) => routes.startClimate(s), vin, generation);
      return;
    }
    if (command === 'remoteStop' && electric) {
      await this.client.send((s) => routes.stopClimate(s), vin, generation);
      return;
    }
    const remote: RemoteCommand = {
      lock: 'door-lock',
      unlock: 'door-unlock',
      remoteStart: 'engine-start',
      remoteStop: 'engine-stop',
    }[command] as RemoteCommand;
    if (generation === '24MM') {
      await this.client.sendGraphQLCommand(remote, vin);
      return;
    }
    await this.client.send((s) => routes.remoteCommand(remote, generation, s, vin), vin, generation);
  }
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
