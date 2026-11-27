import type { API, Characteristic, CharacteristicValue, Logging, PlatformAccessory, Service } from 'homebridge';
import { PLUGIN_VERSION } from './settings';
import type { VehicleCommand } from './api';
import type { ControllerListener, VehicleController, VehicleState } from './controller';
import type { RemoteStatus, VehicleSummary } from './parse';
import {
  batteryState,
  contactState,
  LOCK_SECURED,
  LOCK_UNKNOWN,
  LOCK_UNSECURED,
  lockCurrentState,
  lockTargetState,
} from './state';

export interface AccessoryOptions {
  exposeOpenings: boolean;
  exposeBattery: boolean;
  remoteStart: boolean;
  /** The vehicle has a remote hatch lock command; a Hatch lock appears once it also reports a hatch lock value. */
  hatchLock?: boolean;
  now?: () => number;
}

const REMOTE_START_SUBTYPE = 'remote-start';
const HATCH_LOCK_SUBTYPE = 'hatch-lock';
/**
 * A report this old is shown as Unknown rather than a confident Locked or
 * Unlocked. With fresh-report requests every 3 hours it only happens when
 * those are failing or turned off.
 */
export const STALE_DISPLAY_MS = 12 * 60 * 60 * 1000;

export class VehicleAccessory implements ControllerListener {
  private readonly Service: typeof Service;
  private readonly Characteristic: typeof Characteristic;
  private controller?: VehicleController;
  private readonly lock: Service;
  private remoteSwitch?: Service;
  private reportedLock = LOCK_UNKNOWN;
  private reportedRunning = false;
  private hatch?: Service;
  private reportedHatch = LOCK_UNKNOWN;
  private openingsLogged = false;
  /** Last value logged per opening key, so each open or close is logged once. */
  private readonly openingStates = new Map<string, boolean>();
  private loggedCharging?: boolean;
  private loggedRunning?: boolean;
  private readonly now: () => number;
  /** Toyota sign-in needs attention: HomeKit shows No Response instead of stale values. */
  private unavailable = false;
  private readonly prefix: string;

  constructor(
    private readonly api: API,
    private readonly log: Logging,
    readonly accessory: PlatformAccessory,
    vehicle: VehicleSummary,
    private readonly options: AccessoryOptions,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.now = options.now ?? Date.now;
    this.prefix = (vehicle.nickname || accessory.displayName || vehicle.displayName).trim();
    const { Service: S, Characteristic: C } = this;

    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Toyota')
      .setCharacteristic(C.Model, [vehicle.modelYear, vehicle.modelName].filter(Boolean).join(' ') || 'Vehicle')
      .setCharacteristic(C.SerialNumber, vehicle.vin)
      .setCharacteristic(C.FirmwareRevision, PLUGIN_VERSION);

    // Doors: the one native service every Toyota with remote lock maps to.
    this.lock =
      accessory.services.find((s) => s.UUID === S.LockMechanism.UUID && !s.subtype) ?? accessory.addService(S.LockMechanism, 'Doors');
    this.name(this.lock, 'Doors');
    // The Home app tile and Siri answers follow the primary service.
    this.lock.setPrimaryService(true);
    this.lock.getCharacteristic(C.LockCurrentState).onGet(() => {
      this.ensureAvailable();
      // The Home app reading the lock means someone is looking at the car.
      this.controller?.noteInterest();
      return this.reportedLock;
    });
    this.lock
      .getCharacteristic(C.LockTargetState)
      .onGet(() => (this.reportedLock === LOCK_UNSECURED ? LOCK_UNSECURED : LOCK_SECURED))
      .onSet((value) => {
        this.ensureAvailable();
        this.setLockTarget(value);
      });
    this.lock.updateCharacteristic(C.LockCurrentState, this.reportedLock);

    this.configureRemoteStart();
    const cachedHatch = accessory.getServiceById(S.LockMechanism, HATCH_LOCK_SUBTYPE);
    if (cachedHatch && options.hatchLock) {
      this.configureHatch(cachedHatch);
    } else if (cachedHatch) {
      accessory.removeService(cachedHatch);
    }
    if (!options.exposeOpenings) {
      this.removeAll(S.ContactSensor.UUID);
    }
    if (!options.exposeBattery) {
      this.removeAll(S.Battery.UUID);
    }
  }

  attach(controller: VehicleController): void {
    this.controller = controller;
  }

  /**
   * Sets the name Siri and the Home app use. Name changes every start, but
   * ConfiguredName is written only while it is empty, so a rename in the Home
   * app is never overwritten. Names carry the vehicle's name, so "Window" or
   * "Door" never collides with the house's own sensors.
   */
  private name(service: Service, label: string): void {
    const { Characteristic: C } = this;
    const full = this.prefix && !label.toLowerCase().startsWith(this.prefix.toLowerCase()) ? `${this.prefix} ${label}` : label;
    service.setCharacteristic(C.Name, full);
    if (!service.testCharacteristic(C.ConfiguredName)) {
      service.addOptionalCharacteristic(C.ConfiguredName);
    }
    const current = service.getCharacteristic(C.ConfiguredName).value;
    if (typeof current !== 'string' || current.trim() === '') {
      service.setCharacteristic(C.ConfiguredName, full);
    }
  }

  /** While Toyota sign-in needs attention, reads and writes answer No Response. */
  setUnavailable(unavailable: boolean): void {
    if (unavailable !== this.unavailable) {
      this.log.info(unavailable ? 'HomeKit shows the vehicle as not responding until you sign in to Toyota again.' : 'HomeKit shows the vehicle again.');
    }
    this.unavailable = unavailable;
  }

  private ensureAvailable(): void {
    if (this.unavailable) {
      this.log.debug('HomeKit request answered No Response: Toyota sign-in needs attention.');
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private removeAll(uuid: string): void {
    for (const service of this.accessory.services.filter((s) => s.UUID === uuid)) {
      this.accessory.removeService(service);
    }
  }

  private configureRemoteStart(): void {
    const { Service: S, Characteristic: C } = this;
    const existing = this.accessory.getServiceById(S.Switch, REMOTE_START_SUBTYPE);
    if (!this.options.remoteStart) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return;
    }
    this.remoteSwitch = existing ?? this.accessory.addService(S.Switch, 'Remote Start', REMOTE_START_SUBTYPE);
    this.name(this.remoteSwitch, 'Remote Start');
    this.remoteSwitch
      .getCharacteristic(C.On)
      .onGet(() => {
        this.ensureAvailable();
        return this.reportedRunning;
      })
      .onSet((value) => {
        this.ensureAvailable();
        this.dispatch(value === true ? 'remoteStart' : 'remoteStop');
      });
  }

  private configureHatch(service: Service): void {
    const { Characteristic: C } = this;
    this.hatch = service;
    this.name(service, 'Hatch');
    service.getCharacteristic(C.LockCurrentState).onGet(() => {
      this.ensureAvailable();
      return this.reportedHatch;
    });
    service
      .getCharacteristic(C.LockTargetState)
      .onGet(() => (this.reportedHatch === LOCK_UNSECURED ? LOCK_UNSECURED : LOCK_SECURED))
      .onSet((value) => {
        this.ensureAvailable();
        this.dispatch(value === C.LockTargetState.SECURED ? 'lockTrunk' : 'unlockTrunk');
      });
  }

  private setLockTarget(value: CharacteristicValue): void {
    this.dispatch(value === this.Characteristic.LockTargetState.SECURED ? 'lock' : 'unlock');
  }

  /**
   * HAP gives set handlers only a few seconds, but Toyota commands are
   * asynchronous, so the command runs in the background and HomeKit shows
   * "Locking..." until the vehicle reports the change or the attempt is abandoned.
   */
  private dispatch(command: VehicleCommand): void {
    const controller = this.controller;
    this.log.info(`HomeKit asked to ${REQUEST_WORDS[command]}.`);
    if (!controller) {
      this.log.warn(`Not sent: the vehicle is not set up yet.`);
      return;
    }
    void controller.command(command).catch((error: unknown) => {
      this.log.error(`Unexpected error running ${command}: ${String(error)}`);
      this.commandFailed(command, 'unexpected error');
    });
  }

  commandFailed(command: VehicleCommand, reason: string): void {
    const { Characteristic: C } = this;
    this.log.warn(`${command} did not complete (${reason}); showing the vehicle's reported state.`);
    if (command === 'lock' || command === 'unlock') {
      this.lock.updateCharacteristic(C.LockTargetState, lockTargetState(asLocked(this.reportedLock), LOCK_SECURED));
    } else if (command === 'lockTrunk' || command === 'unlockTrunk') {
      this.hatch?.updateCharacteristic(C.LockTargetState, lockTargetState(asLocked(this.reportedHatch), LOCK_SECURED));
    } else {
      this.remoteSwitch?.updateCharacteristic(C.On, this.reportedRunning);
    }
  }

  private updateHatch(status: RemoteStatus, tooOld: boolean, pending: boolean): void {
    const { Service: S, Characteristic: C } = this;
    const locked = tooOld ? null : hatchLocked(status);
    if (!this.hatch) {
      if (!this.options.hatchLock || hatchLocked(status) === null) {
        return;
      }
      this.configureHatch(this.accessory.addService(S.LockMechanism, 'Hatch', HATCH_LOCK_SUBTYPE));
      this.log.info('The vehicle reports a hatch lock state, so a Hatch lock is now in HomeKit.');
    }
    this.reportedHatch = lockCurrentState(locked);
    this.hatch!.updateCharacteristic(C.LockCurrentState, this.reportedHatch);
    if (!pending) {
      this.hatch!.updateCharacteristic(C.LockTargetState, lockTargetState(locked, LOCK_SECURED));
    }
  }

  stateChanged(state: VehicleState): void {
    const { Service: S, Characteristic: C } = this;
    const pending = this.controller?.commandPending === true;

    if (state.status) {
      const status = state.status;
      if (!this.openingsLogged && status.openings.length > 0) {
        this.openingsLogged = true;
        this.log.info(describeOpenings(status));
      }
      const tooOld = status.reportedAtMs !== undefined && this.now() - status.reportedAtMs > STALE_DISPLAY_MS;
      const doorsLocked = tooOld ? null : status.doorsLocked;
      const previous = this.reportedLock;
      this.reportedLock = lockCurrentState(doorsLocked);
      if (this.reportedLock !== previous) {
        this.log.info(
          tooOld
            ? `Showing the doors as unknown: the vehicle's last report (${status.reportedAt ?? 'no time'}) is too old to trust.`
            : describeLockReport(status),
        );
      }
      this.lock.updateCharacteristic(C.LockCurrentState, this.reportedLock);
      if (!pending) {
        this.lock.updateCharacteristic(C.LockTargetState, lockTargetState(doorsLocked, LOCK_SECURED));
      }
      this.updateHatch(status, tooOld, pending);
      if (this.options.exposeOpenings) {
        for (const opening of state.status.openings) {
          const value = contactState(opening.open);
          if (value === undefined) {
            continue;
          }
          const service =
            this.accessory.getServiceById(S.ContactSensor, opening.key) ??
            this.accessory.addService(S.ContactSensor, opening.label, opening.key);
          this.name(service, opening.label);
          const open = opening.open === true;
          const before = this.openingStates.get(opening.key);
          if (before !== undefined && before !== open) {
            this.log.info(`${opening.label} reported ${open ? 'open' : 'closed'} (${status.reportedAt ?? 'no report time'}).`);
          }
          this.openingStates.set(opening.key, open);
          service.updateCharacteristic(C.ContactSensorState, value);
          // A position from a report too old to trust is flagged, not presented as current.
          service.updateCharacteristic(C.StatusFault, tooOld ? C.StatusFault.GENERAL_FAULT : C.StatusFault.NO_FAULT);
        }
      }
    }

    if (this.options.exposeBattery && state.electric) {
      const battery = batteryState(state.electric);
      if (battery) {
        const service = this.accessory.getService(S.Battery) ?? this.accessory.addService(S.Battery, 'EV Battery');
        this.name(service, 'EV Battery');
        const charging = battery.chargingState === C.ChargingState.CHARGING;
        if (this.loggedCharging !== undefined && this.loggedCharging !== charging) {
          this.log.info(`EV battery ${charging ? 'started charging' : 'stopped charging'} at ${battery.level}%.`);
        }
        this.loggedCharging = charging;
        service.updateCharacteristic(C.BatteryLevel, battery.level);
        service.updateCharacteristic(C.StatusLowBattery, battery.lowBattery ? 1 : 0);
        service.updateCharacteristic(C.ChargingState, battery.chargingState);
      }
    }

    if (state.running !== undefined) {
      if (this.loggedRunning !== undefined && this.loggedRunning !== state.running) {
        this.log.info(`The vehicle reports the engine or climate ${state.running ? 'running' : 'off'}.`);
      }
      this.loggedRunning = state.running;
    }
    if (this.remoteSwitch && state.running !== undefined) {
      this.reportedRunning = state.running;
      if (!pending) {
        this.remoteSwitch.updateCharacteristic(C.On, state.running);
      }
    }
  }
}

const REQUEST_WORDS: Record<VehicleCommand, string> = {
  lock: 'lock the doors',
  unlock: 'unlock the doors',
  remoteStart: 'start the vehicle remotely',
  remoteStop: 'stop the remote start',
  closeWindows: 'close the windows',
  closeMoonroof: 'close the moonroof',
  lockTrunk: 'lock the hatch',
  unlockTrunk: 'unlock the hatch',
};

function asLocked(state: number): boolean | null {
  return state === LOCK_SECURED ? true : state === LOCK_UNSECURED ? false : null;
}

/** The hatch's own lock value: locked only if every reporting hatch is, unlocked if any is not. */
export function hatchLocked(status: RemoteStatus): boolean | null {
  const values = status.openings.filter((o) => o.kind === 'trunk' && o.locked !== null).map((o) => o.locked);
  if (values.length === 0) {
    return null;
  }
  return values.every((v) => v === true);
}

/** Logged once per start: every opening the vehicle reports, with its position and lock value. */
export function describeOpenings(status: RemoteStatus): string {
  const word = (v: boolean | null, yes: string, no: string): string => (v === true ? yes : v === false ? no : `no ${yes === 'open' ? 'position' : 'lock value'}`);
  const parts = status.openings.map((o) => {
    const lock = o.kind === 'door' || o.kind === 'trunk' ? `, ${word(o.locked, 'locked', 'unlocked')}` : '';
    return `${o.label} (${word(o.open, 'open', 'closed')}${lock})`;
  });
  return `The vehicle reports: ${parts.join('; ')}.`;
}

/**
 * One line per change in the reported lock state, so a HomeKit tile that looks
 * wrong can be traced to Toyota's report: its age, and which doors lacked a lock value.
 */
export function describeLockReport(status: RemoteStatus): string {
  const state = status.doorsLocked === true ? 'locked' : status.doorsLocked === false ? 'unlocked' : 'unknown';
  const time = status.reportedAt ? `Toyota report from ${status.reportedAt}` : 'Toyota gave no report time';
  let line = `Doors reported ${state} (${time}).`;
  if (status.doorsLocked === null) {
    const doors = status.openings.filter((o) => o.kind === 'door');
    const detail = doors.map((o) => `${o.label}: ${o.locked === true ? 'locked' : o.locked === false ? 'unlocked' : 'no lock value'}`);
    line += doors.length > 0 ? ` ${detail.join(', ')}.` : ' The report listed no doors.';
  }
  return line;
}
