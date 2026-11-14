import type { ElectricStatus } from './parse';

/* HAP numeric values, kept here so this module stays free of homebridge imports. */
export const LOCK_UNSECURED = 0;
export const LOCK_SECURED = 1;
export const LOCK_UNKNOWN = 3;

export const CONTACT_DETECTED = 0; // closed
export const CONTACT_NOT_DETECTED = 1; // open

export const NOT_CHARGING = 0;
export const CHARGING = 1;

export const LOW_BATTERY_PERCENT = 20;

export function lockCurrentState(doorsLocked: boolean | null | undefined): number {
  if (doorsLocked === true) {
    return LOCK_SECURED;
  }
  if (doorsLocked === false) {
    return LOCK_UNSECURED;
  }
  return LOCK_UNKNOWN;
}

/** The target HomeKit should show when nothing is in flight: mirror the reported state. */
export function lockTargetState(doorsLocked: boolean | null | undefined, previous: number): number {
  if (doorsLocked === true) {
    return LOCK_SECURED;
  }
  if (doorsLocked === false) {
    return LOCK_UNSECURED;
  }
  return previous;
}

/** Returns undefined when Toyota did not report a position, so the last value is kept. */
export function contactState(open: boolean | null | undefined): number | undefined {
  if (open === true) {
    return CONTACT_NOT_DETECTED;
  }
  if (open === false) {
    return CONTACT_DETECTED;
  }
  return undefined;
}

export interface BatteryState {
  level: number;
  lowBattery: boolean;
  chargingState: number;
}

/** Only an actual reported state of charge produces a Battery service reading. */
export function batteryState(electric: ElectricStatus): BatteryState | undefined {
  if (electric.batteryPercent === undefined) {
    return undefined;
  }
  const level = Math.round(electric.batteryPercent);
  return {
    level,
    lowBattery: level <= LOW_BATTERY_PERCENT,
    chargingState: electric.charging === true ? CHARGING : NOT_CHARGING,
  };
}

/** Whether the lock command the user asked for matches what Toyota now reports. */
export function lockCommandConfirmed(targetSecured: boolean, doorsLocked: boolean | null): boolean {
  return doorsLocked === targetSecured;
}
