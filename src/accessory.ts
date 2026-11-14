import type { API, Characteristic, CharacteristicValue, Logging, PlatformAccessory, Service } from 'homebridge';
import type { VehicleCommand } from './api';
import type { ControllerListener, VehicleController, VehicleState } from './controller';
import type { VehicleSummary } from './parse';
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
}

const REMOTE_START_SUBTYPE = 'remote-start';

export class VehicleAccessory implements ControllerListener {
  private readonly Service: typeof Service;
  private readonly Characteristic: typeof Characteristic;
  private controller?: VehicleController;
  private readonly lock: Service;
  private remoteSwitch?: Service;
  private reportedLock = LOCK_UNKNOWN;
  private reportedRunning = false;

  constructor(
    private readonly api: API,
    private readonly log: Logging,
    readonly accessory: PlatformAccessory,
    vehicle: VehicleSummary,
    private readonly options: AccessoryOptions,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    const { Service: S, Characteristic: C } = this;

    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Toyota')
      .setCharacteristic(C.Model, [vehicle.modelYear, vehicle.modelName].filter(Boolean).join(' ') || 'Vehicle')
      .setCharacteristic(C.SerialNumber, vehicle.vin);

    // Doors: the one native service every Toyota with remote lock maps to.
    this.lock = accessory.getService(S.LockMechanism) ?? accessory.addService(S.LockMechanism, 'Doors');
    this.lock.setCharacteristic(C.Name, 'Doors');
    this.lock.getCharacteristic(C.LockCurrentState).onGet(() => this.reportedLock);
    this.lock
      .getCharacteristic(C.LockTargetState)
      .onGet(() => (this.reportedLock === LOCK_UNSECURED ? LOCK_UNSECURED : LOCK_SECURED))
      .onSet((value) => this.setLockTarget(value));
    this.lock.updateCharacteristic(C.LockCurrentState, this.reportedLock);

    this.configureRemoteStart();
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
    this.remoteSwitch.setCharacteristic(C.Name, 'Remote Start');
    this.remoteSwitch
      .getCharacteristic(C.On)
      .onGet(() => this.reportedRunning)
      .onSet((value) => {
        this.dispatch(value === true ? 'remoteStart' : 'remoteStop');
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
    if (!controller) {
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
      const doorsLocked = this.reportedLock === LOCK_SECURED ? true : this.reportedLock === LOCK_UNSECURED ? false : null;
      this.lock.updateCharacteristic(C.LockTargetState, lockTargetState(doorsLocked, LOCK_SECURED));
    } else {
      this.remoteSwitch?.updateCharacteristic(C.On, this.reportedRunning);
    }
  }

  stateChanged(state: VehicleState): void {
    const { Service: S, Characteristic: C } = this;
    const pending = this.controller?.commandPending === true;

    if (state.status) {
      const doorsLocked = state.status.doorsLocked;
      this.reportedLock = lockCurrentState(doorsLocked);
      this.lock.updateCharacteristic(C.LockCurrentState, this.reportedLock);
      if (!pending) {
        this.lock.updateCharacteristic(C.LockTargetState, lockTargetState(doorsLocked, LOCK_SECURED));
      }
      if (this.options.exposeOpenings) {
        for (const opening of state.status.openings) {
          const value = contactState(opening.open);
          if (value === undefined) {
            continue;
          }
          const service =
            this.accessory.getServiceById(S.ContactSensor, opening.key) ??
            this.accessory.addService(S.ContactSensor, opening.label, opening.key);
          service.setCharacteristic(C.Name, opening.label);
          service.updateCharacteristic(C.ContactSensorState, value);
        }
      }
    }

    if (this.options.exposeBattery && state.electric) {
      const battery = batteryState(state.electric);
      if (battery) {
        const service = this.accessory.getService(S.Battery) ?? this.accessory.addService(S.Battery, 'EV Battery');
        service.setCharacteristic(C.Name, 'EV Battery');
        service.updateCharacteristic(C.BatteryLevel, battery.level);
        service.updateCharacteristic(C.StatusLowBattery, battery.lowBattery ? 1 : 0);
        service.updateCharacteristic(C.ChargingState, battery.chargingState);
      }
    }

    if (this.remoteSwitch && state.running !== undefined) {
      this.reportedRunning = state.running;
      if (!pending) {
        this.remoteSwitch.updateCharacteristic(C.On, state.running);
      }
    }
  }
}
