import { join } from 'node:path';
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { VehicleAccessory } from './accessory';
import { classifyError, ToyotaVehicleApi } from './api';
import { type ChallengeStore, type PendingChallenge, ToyotaAuth } from './auth';
import { ToyotaClient } from './client';
import { parseConfig, type ToyotaConfig } from './config';
import { describe, VehicleController, type WakeStore } from './controller';
import { type AutoLockStore, isAutoLockState } from './autolock';
import { type Generation, prepareCapabilities, type VehicleSummary } from './parse';
import { FAST_POLL_WINDOW_MS, Poller, type PollOutcome } from './poller';
import { FileStore, isSession, type Session } from './session';
import { PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from './settings';
import { isVehicleStatus, type VehicleStatus } from './ui';

const DEFAULT_GENERATION: Generation = '21MM';

function isPending(value: unknown): value is PendingChallenge {
  const v = value as Record<string, unknown> | null;
  return typeof v === 'object' && v !== null && typeof v['username'] === 'string' && typeof v['savedAt'] === 'number' && typeof v['payload'] === 'object' && v['payload'] !== null;
}

const SESSION_WATCH_MS = 30_000;

const mask = (vin: string): string => `…${vin.slice(-4)}`;

/** RedLink's app-open rule: no wake within 15 minutes of a wake or of the car's own report. */
const INTEREST_WAKE_MS = 15 * 60 * 1000;

export class ToyotaPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly controllers: VehicleController[] = [];
  private readonly views: VehicleAccessory[] = [];
  private readonly config?: ToyotaConfig;
  private poller?: Poller;
  private discovered = false;
  private degraded = false;
  private vehicleApi?: ToyotaVehicleApi;
  private client?: ToyotaClient;
  private statusFile?: FileStore<VehicleStatus>;
  private sessionWatch?: NodeJS.Timeout;

  constructor(
    private log: Logging,
    rawConfig: PlatformConfig,
    private readonly api: API,
  ) {
    const result = parseConfig(rawConfig as Record<string, unknown>);
    result.warnings.forEach((w) => this.log.warn(w));
    if (!result.config) {
      result.errors.forEach((e) => this.log.error(e));
      this.log.error('Toyota plugin is not configured; no accessories will be created.');
      return;
    }
    this.config = result.config;
    if (result.config.debug) {
      this.log = verboseLogger(log);
    }
    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => {
      this.poller?.stop();
      this.stopSessionWatch();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
    this.refuseUntilReady(accessory);
  }

  /**
   * A cached accessory has no handlers until Toyota answers the first vehicle
   * list. Until then a lock or switch write would be accepted and dropped, so
   * answer No Response instead. VehicleAccessory replaces these handlers.
   */
  private refuseUntilReady(accessory: PlatformAccessory): void {
    const { Characteristic: C, HapStatusError, HAPStatus } = this.api.hap;
    const refuse = (): never => {
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    };
    for (const service of accessory.services) {
      if (service.testCharacteristic(C.LockTargetState)) {
        service.getCharacteristic(C.LockTargetState).onSet(refuse);
      }
      if (service.UUID === this.api.hap.Service.Switch.UUID) {
        service.getCharacteristic(C.On).onSet(refuse);
      }
    }
  }

  private start(): void {
    const config = this.config;
    if (!config) {
      return;
    }
    this.log.info(describeSettings(config));
    try {
      const dir = join(this.api.user.storagePath(), 'homebridge-toyota');
      const sessions = new FileStore<Session>(join(dir, 'session.json'), isSession);
      const challengeFile = new FileStore<PendingChallenge>(join(dir, 'pending-otp.json'), isPending);
      const challenges: ChallengeStore = {
        load: () => challengeFile.load(),
        save: (c) => challengeFile.save(c),
        clear: () => challengeFile.clear(),
      };
      const auth = new ToyotaAuth(fetch, challenges);
      this.client = new ToyotaClient(config, auth, sessions, fetch, this.log);
      this.statusFile = new FileStore<VehicleStatus>(join(dir, 'status.json'), isVehicleStatus);
      this.vehicleApi = new ToyotaVehicleApi(this.client);
      this.poller = new Poller(() => this.tick(), config.pollIntervalMinutes * 60_000, Math.random, Date.now, (m) => this.log.debug(m));
      this.poller.start(0);
    } catch (error) {
      this.log.error(`Toyota plugin failed to start: ${describe(error)}`);
    }
  }

  /** One scheduled cycle. Must never throw. */
  private async tick(): Promise<PollOutcome> {
    let outcome: PollOutcome = 'ok';
    let message: string | undefined;
    try {
      if (!this.discovered) {
        await this.discover();
      }
      for (const controller of this.controllers) {
        const result = await controller.poll();
        if (result !== 'ok' && (outcome === 'ok' || result === 'fatal' || result === 'rateLimited')) {
          outcome = result;
          message = controller.lastError;
        }
      }
    } catch (error) {
      outcome = classifyError(error);
      message = describe(error);
    }
    this.report(outcome, message);
    if (outcome === 'fatal') {
      this.watchForNewSession();
    }
    return outcome;
  }

  /**
   * After a sign-in problem the poller stops. The settings page can fix it by
   * writing a new session file, so check for that cheaply and resume polling.
   */
  private watchForNewSession(): void {
    if (this.sessionWatch || !this.client) {
      return;
    }
    this.sessionWatch = setInterval(() => {
      if (this.client?.sessionFileChanged()) {
        this.stopSessionWatch();
        this.log.info('A new Toyota sign-in was saved from the settings page; resuming updates.');
        this.degraded = false;
        this.poller?.start(0);
      }
    }, SESSION_WATCH_MS);
    this.sessionWatch.unref();
  }

  /** Last wake time per vehicle, kept beside the session so a restart does not wake the car again. */
  private wakeStore(vin: string, name = 'wake'): WakeStore {
    const file = new FileStore<{ wokeAt: number }>(
      join(this.api.user.storagePath(), 'homebridge-toyota', `${name}-${vin}.json`),
      (v): v is { wokeAt: number } => typeof v === 'object' && v !== null && typeof (v as { wokeAt?: unknown }).wokeAt === 'number',
    );
    return { load: () => file.load()?.wokeAt, save: (wokeAt) => file.save({ wokeAt }) };
  }

  private autoLockStore(vin: string): AutoLockStore {
    const file = new FileStore(join(this.api.user.storagePath(), 'homebridge-toyota', `autolock-${vin}.json`), isAutoLockState);
    return { load: () => file.load(), save: (state) => file.save(state) };
  }

  private stopSessionWatch(): void {
    if (this.sessionWatch) {
      clearInterval(this.sessionWatch);
      this.sessionWatch = undefined;
    }
  }

  private report(outcome: PollOutcome, message: string | undefined): void {
    // Signed out: HomeKit shows No Response rather than stale state. Any other outcome keeps the last values.
    for (const view of this.views) {
      view.setUnavailable(outcome === 'fatal');
    }
    if (outcome === 'ok') {
      if (this.degraded) {
        this.log.info('Toyota connected services are reachable again.');
      }
      this.degraded = false;
      return;
    }
    if (outcome === 'fatal') {
      this.log.error(`${message ?? 'Toyota sign-in needs attention.'} Polling is paused until you sign in from the plugin's settings page or restart Homebridge.`);
    } else if (!this.degraded) {
      this.log.warn(`Toyota update failed (${outcome}): ${message ?? 'unknown error'}. Retrying with backoff; further failures are logged at debug level.`);
    } else {
      this.log.debug(`Toyota update still failing (${outcome}): ${message ?? 'unknown error'}`);
    }
    this.degraded = true;
  }

  private async discover(): Promise<void> {
    const config = this.config!;
    const vehicles = (await this.vehicleApi!.listVehicles()).filter((v) => !config.vin || v.vin.toUpperCase() === config.vin);
    try {
      this.statusFile?.save({ vehicleCount: vehicles.length, checkedAt: Date.now() });
    } catch {
      // status is informational only
    }
    if (vehicles.length === 0) {
      this.log.warn(config.vin ? 'The configured VIN was not found on this Toyota account.' : 'No vehicles were found on this Toyota account.');
      this.discovered = true;
      return;
    }
    const seen = new Set<string>();
    for (const vehicle of vehicles) {
      seen.add(this.addVehicle(vehicle));
    }
    for (const [uuid, accessory] of this.cached) {
      if (!seen.has(uuid)) {
        this.log.info(`Removing accessory for a vehicle no longer on the account: ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cached.delete(uuid);
      }
    }
    this.discovered = true;
  }

  private addVehicle(vehicle: VehicleSummary): string {
    const config = this.config!;
    const uuid = this.api.hap.uuid.generate(`toyota:${vehicle.vin.toUpperCase()}`);
    let accessory = this.cached.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(config.vehicleName ?? vehicle.displayName, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.cached.set(uuid, accessory);
      this.log.info(`Added ${vehicle.displayName} (${mask(vehicle.vin)}).`);
    }
    const generation = config.generation ?? vehicle.generation;
    if (!generation) {
      this.log.warn(`Toyota did not report a generation for ${vehicle.displayName}; assuming ${DEFAULT_GENERATION}. Set "generation" in the config if commands are rejected.`);
    }
    const subscriptions = vehicle.subscriptions.map((s) => `${s.name}: ${s.status ?? 'unknown'}`).join(', ') || 'none reported';
    this.log.info(`${vehicle.displayName}: generation ${generation ?? DEFAULT_GENERATION}; remote capabilities [${vehicle.capabilities.join(', ') || 'none reported'}]; subscriptions: ${subscriptions}.`);

    const capabilities = prepareCapabilities(vehicle, generation ?? DEFAULT_GENERATION);
    const options = {
      exposeOpenings: config.exposeOpenings,
      exposeBattery: config.exposeBattery,
      remoteStart: config.remoteStartEnabled,
      hatchLock: capabilities.lockTrunk,
      name: config.vehicleName,
      home: config.home,
    };
    const view = new VehicleAccessory(this.api, this.log, accessory, vehicle, options);
    const controller = new VehicleController(
      vehicle.vin,
      generation ?? DEFAULT_GENERATION,
      this.vehicleApi!,
      {
        remoteStart: config.remoteStartEnabled,
        exposeBattery: config.exposeBattery,
        electricHint: looksElectric(vehicle),
        prepare: config.remoteStartEnabled && config.remoteStartPrepare ? capabilities : undefined,
        staleReportMs: config.staleReportHours * 60 * 60 * 1000,
        wakeStore: this.wakeStore(vehicle.vin),
        interestWakeMs: config.wakeOnHomeAppOpen ? INTEREST_WAKE_MS : 0,
        evChargingRefreshMs: config.chargingRefreshMinutes * 60_000,
        evWakeStore: this.wakeStore(vehicle.vin, 'ev-wake'),
        onActivity: () => this.poller?.hurry(Date.now() + FAST_POLL_WINDOW_MS),
        autoLock: config.autoLockMinutes === undefined ? undefined : { afterMs: config.autoLockMinutes * 60_000, store: this.autoLockStore(vehicle.vin) },
      },
      view,
      this.log,
    );
    view.attach(controller);
    this.controllers.push(controller);
    this.views.push(view);
    return uuid;
  }
}

function looksElectric(vehicle: VehicleSummary): boolean {
  const record = vehicle.record as Record<string, unknown> | null;
  return record?.['evVehicle'] === true;
}

/** Debug lines go out at info level, marked, so they show without Homebridge's -D flag. */
export function verboseLogger(log: Logging): Logging {
  return new Proxy(log, {
    get(target, property, receiver) {
      if (property === 'debug') {
        return (message: string, ...parameters: unknown[]) => target.info(`[debug] ${message}`, ...parameters);
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** One startup line with the settings in effect. No email, password, keys or VIN. */
export function describeSettings(config: ToyotaConfig): string {
  const parts = [
    `polling every ${config.pollIntervalMinutes} min`,
    config.staleReportHours > 0 ? `fresh report after ${config.staleReportHours} h` : 'no stale-report requests',
    config.wakeOnHomeAppOpen ? 'fresh report on Home app open' : 'no Home app requests',
    config.chargingRefreshMinutes > 0 ? `charge level every ${config.chargingRefreshMinutes} min while charging` : 'no charging refresh',
    config.autoLockMinutes === undefined ? 'auto-lock off' : `auto-lock after ${config.autoLockMinutes} min`,
    config.remoteStartEnabled ? `Remote Start on${config.remoteStartPrepare ? ' with preparation' : ''}` : 'Remote Start off',
    `sensors ${config.exposeOpenings ? 'on' : 'off'}`,
    `battery ${config.exposeBattery ? 'on' : 'off'}`,
  ];
  if (config.generation) {
    parts.push(`generation forced to ${config.generation}`);
  }
  if (config.vin) {
    parts.push(`one vehicle (…${config.vin.slice(-4)})`);
  }
  if (config.home) {
    parts.push(`At Home sensor within ${config.home.radiusMeters} m`);
  }
  if (config.vehicleName) {
    parts.push(`named "${config.vehicleName}"`);
  }
  if (config.debug) {
    parts.push('debug logging on');
  }
  return `Toyota plugin ${PLUGIN_VERSION}: ${parts.join(', ')}.`;
}
