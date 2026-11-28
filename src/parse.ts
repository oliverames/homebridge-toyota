import { at, bool, isObject, num, str } from './json';

/* -------------------------------------------------------------------------- */
/* Vehicle list                                                               */
/* -------------------------------------------------------------------------- */

export type Generation = '17CY' | '17CYPLUS' | '21MM' | '24MM';
export const GENERATIONS: readonly Generation[] = ['17CY', '17CYPLUS', '21MM', '24MM'];

export interface VehicleSummary {
  vin: string;
  displayName: string;
  modelName?: string;
  modelYear?: string;
  nickname?: string;
  generation?: Generation;
  /** Enabled remote capability names, e.g. "remoteStart". Empty when not declared. */
  capabilities: string[];
  subscriptions: SubscriptionSummary[];
  record: unknown;
}

export interface SubscriptionSummary {
  name: string;
  status?: string;
  daysRemaining?: number;
}

const CONTAINER_KEYS = ['payload', 'vehicles', 'vehicleList', 'vehicleSummary', 'vehicleInfo', 'garage', 'data'];

function vehicleVin(record: unknown): string | undefined {
  for (const key of ['vin', 'VIN', 'vehicleVin', 'vehicleVIN']) {
    const vin = str(at(record, key));
    // A VIN is 17 letters and digits; anything else is not trusted, since the VIN also names files on disk.
    if (vin && /^[A-Za-z0-9]{17}$/.test(vin)) {
      return vin;
    }
  }
  return undefined;
}

function vehicleRecords(value: unknown): unknown[] {
  if (vehicleVin(value)) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(vehicleRecords);
  }
  if (!isObject(value)) {
    return [];
  }
  const preferred = CONTAINER_KEYS.flatMap((key) => vehicleRecords(value[key]));
  if (preferred.length > 0) {
    return preferred;
  }
  return Object.values(value).flatMap(vehicleRecords);
}

function declaredList(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (vehicleVin(value)) {
    return [value];
  }
  if (!isObject(value)) {
    return undefined;
  }
  for (const key of CONTAINER_KEYS) {
    const found = declaredList(value[key]);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** True when the payload is shaped like a vehicle list (possibly empty). */
export function recognizesVehicleList(value: unknown): boolean {
  const records = declaredList(value);
  if (!records) {
    return false;
  }
  return records.length === 0 || records.every((item) => vehicleRecords(item).length > 0);
}

function isCapabilityEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'y', 'supported', 'available', 'enabled', 'active'].includes(value.trim().toLowerCase());
  }
  if (Array.isArray(value)) {
    return value.some(isCapabilityEnabled);
  }
  if (isObject(value)) {
    for (const key of ['supported', 'enabled', 'available', 'capable', 'isSupported', 'isEnabled', 'isAvailable', 'status', 'state']) {
      if (value[key] !== undefined) {
        return isCapabilityEnabled(value[key]);
      }
    }
  }
  return false;
}

export function enabledCapabilityNames(record: unknown): string[] {
  const names: string[] = [];
  for (const group of ['remoteServiceCapabilities', 'extendedCapabilities', 'vehicleCapabilities']) {
    const object = at(record, group);
    if (isObject(object)) {
      for (const [key, value] of Object.entries(object)) {
        if (isCapabilityEnabled(value)) {
          names.push(key);
        }
      }
    }
  }
  return [...new Set(names)].sort();
}

export function declaresCapabilityContainer(record: unknown): boolean {
  return ['remoteServiceCapabilities', 'extendedCapabilities', 'vehicleCapabilities'].some(
    (key) => at(record, key) !== undefined,
  );
}

function parseSubscriptions(record: unknown): SubscriptionSummary[] {
  const list = at(record, 'subscriptions');
  if (!Array.isArray(list)) {
    return [];
  }
  const out: SubscriptionSummary[] = [];
  for (const entry of list) {
    const name = str(at(entry, 'serviceName')) ?? str(at(entry, 'name'));
    if (!name) {
      continue;
    }
    out.push({
      name,
      status: str(at(entry, 'subscriptionStatus')) ?? str(at(entry, 'status')),
      daysRemaining: num(at(entry, 'subscriptionRemainingDays')),
    });
  }
  return out;
}

function summarize(record: unknown, vin: string): VehicleSummary {
  const nickname = str(at(record, 'nickName')) ?? str(at(record, 'nickname')) ?? str(at(record, 'alias')) ?? str(at(record, 'vehicleName'));
  const modelName = str(at(record, 'modelName')) ?? str(at(record, 'model')) ?? str(at(record, 'modelDescription'));
  const modelYear = str(at(record, 'modelYear')) ?? str(at(record, 'year'));
  const rawGeneration = str(at(record, 'generation'))?.toUpperCase();
  const generation = GENERATIONS.find((g) => g === rawGeneration);
  const composed = [modelYear, modelName].filter(Boolean).join(' ');
  // A nickname equal to the VIN is Toyota's default; ignore it.
  const usableNickname = nickname && nickname.toLowerCase() !== vin.toLowerCase() ? nickname : undefined;
  return {
    vin,
    displayName: usableNickname ?? (composed || `Vehicle ${vin.slice(-4).toUpperCase()}`),
    modelName,
    modelYear,
    nickname,
    generation,
    capabilities: enabledCapabilityNames(record),
    subscriptions: parseSubscriptions(record),
    record,
  };
}

export function parseVehicleList(value: unknown): VehicleSummary[] {
  const seen = new Set<string>();
  const out: VehicleSummary[] = [];
  for (const record of vehicleRecords(value)) {
    const vin = vehicleVin(record);
    if (!vin || seen.has(vin.toUpperCase())) {
      continue;
    }
    seen.add(vin.toUpperCase());
    out.push(summarize(record, vin));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Remote status: doors, windows, trunk, hood                                  */
/* -------------------------------------------------------------------------- */

export type OpeningKind = 'door' | 'window' | 'roof' | 'trunk' | 'hood';

export interface Opening {
  /** Stable key, e.g. "door:driver-side-door". */
  key: string;
  kind: OpeningKind;
  label: string;
  /** true = open/ajar, false = closed, null = not reported. */
  open: boolean | null;
  /** true = locked, false = unlocked, null = not reported. Doors and the trunk or hatch only. */
  locked: boolean | null;
}

export interface RemoteStatus {
  openings: Opening[];
  /** All reporting doors locked = true, any unlocked = false, otherwise null. */
  doorsLocked: boolean | null;
  /** When the vehicle last uploaded this report (Toyota's occurrenceDate), as Toyota wrote it. The report can be hours old. */
  reportedAt?: string;
  /** The same moment in epoch milliseconds, when it parses to a plausible past time. */
  reportedAtMs?: number;
  /** Where the vehicle was when it last reported its position (remote status `latitude`/`longitude`). */
  location?: VehicleLocation;
}

export interface VehicleLocation {
  latitude: number;
  longitude: number;
  /** `locationAcquisitionDatetime`, when given. */
  reportedAt?: string;
  reportedAtMs?: number;
}

/** Remote status carries the last position. 0,0 and out-of-range values are not positions. */
export function parseLocation(data: unknown, now: number = Date.now()): VehicleLocation | undefined {
  for (const root of [[], ['payload']]) {
    const latitude = num(at(data, ...root, 'latitude'));
    const longitude = num(at(data, ...root, 'longitude'));
    if (latitude === undefined || longitude === undefined) {
      continue;
    }
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0)) {
      return undefined;
    }
    const acquired = at(data, ...root, 'locationAcquisitionDatetime');
    return { latitude, longitude, ...(acquired === undefined ? {} : reportTime({ occurrenceDate: acquired }, now)) };
  }
  return undefined;
}

/** Great-circle distance in metres. */
export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

interface Section {
  group: string;
  name: string;
  values: string[];
}

const TITLE_KEYS = ['section', 'category', 'name', 'title', 'displayName', 'display_name', 'label', 'type'];
const VALUE_KEYS = ['value', 'displayValue', 'status', 'state', 'description', 'name', 'title', 'label'];

function titleOf(value: unknown): string | undefined {
  for (const key of TITLE_KEYS) {
    const title = str(at(value, key));
    if (title) {
      return title;
    }
  }
  return undefined;
}

function valueStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    const s = str(value);
    return s ? [s] : [];
  }
  if (typeof value === 'boolean') {
    return [value ? 'true' : 'false'];
  }
  if (typeof value === 'number') {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap(valueStrings);
  }
  if (!isObject(value)) {
    return [];
  }
  const preferred = VALUE_KEYS.flatMap((key) => (value[key] === undefined ? [] : valueStrings(value[key])));
  if (preferred.length > 0) {
    return preferred;
  }
  return Object.values(value).flatMap(valueStrings);
}

function sectionsIn(value: unknown, groupName: string): Section[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => sectionsIn(item, groupName));
  }
  if (!isObject(value)) {
    const values = valueStrings(value);
    return values.length === 0 ? [] : [{ group: groupName, name: '', values }];
  }
  const group = titleOf(value) ?? groupName;
  const sections = value['sections'];
  if (Array.isArray(sections)) {
    return sections.map((section) => ({ group, name: titleOf(section) ?? '', values: valueStrings(section) }));
  }
  const values = value['values'];
  if (Array.isArray(values)) {
    return [{ group: groupName, name: titleOf(value) ?? '', values: values.flatMap(valueStrings) }];
  }
  return Object.values(value).flatMap((child) => sectionsIn(child, group));
}

function sectionRoots(value: unknown): unknown[] {
  const candidates = [
    at(value, 'vehicleStatus'),
    at(value, 'payload', 'vehicleStatus'),
    at(value, 'status', 'payload', 'vehicleStatus'),
    at(value, 'vehicleStatusResponse', 'payload', 'vehicleStatus'),
    at(value, 'data', 'vehicleStatus'),
  ];
  const arrays = candidates.filter(Array.isArray).flat();
  return arrays.length > 0 ? arrays : [value];
}

function classify(section: Section): OpeningKind | undefined {
  const h = `${section.group} ${section.name}`.toLowerCase();
  if (h.includes('window')) {
    return 'window';
  }
  if (h.includes('moon roof') || h.includes('moonroof') || h.includes('sunroof') || h.includes('roof')) {
    return 'roof';
  }
  if (h.includes('hatch') || h.includes('trunk') || h.includes('tailgate') || h.includes('backdoor') || h.includes('back door')) {
    return 'trunk';
  }
  if (h.includes('hood')) {
    return 'hood';
  }
  if (h.includes('door')) {
    return 'door';
  }
  return undefined;
}

/** Position only: "closed" is not "locked". Returns null when no position token. */
function openState(section: Section): boolean | null {
  const tokens = section.values.map((v) => v.toLowerCase().replace(/[^a-z0-9]/g, ''));
  if (tokens.some((t) => t.includes('open') || t.includes('ajar') || t.includes('notclosed'))) {
    return true;
  }
  if (tokens.some((t) => t.includes('closed'))) {
    return false;
  }
  return null;
}

/** Lock token only. "unlocked" contains "locked", so it is checked first. */
function lockState(section: Section): boolean | null {
  for (const raw of section.values) {
    const v = raw.toLowerCase();
    if (v.includes('unlocked')) {
      return false;
    }
    if (v.includes('locked')) {
      return true;
    }
  }
  return null;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function mergeTri(a: boolean | null, b: boolean | null, dominant: boolean): boolean | null {
  if (a === dominant || b === dominant) {
    return dominant;
  }
  return a ?? b;
}

export function parseRemoteStatus(data: unknown): RemoteStatus {
  const sections = sectionRoots(data).flatMap((root) => sectionsIn(root, titleOf(root) ?? ''));
  const byKey = new Map<string, Opening>();
  for (const section of sections) {
    const kind = classify(section);
    if (!kind) {
      continue;
    }
    const label = section.name || section.group;
    const key = `${kind}:${slug(label)}`;
    const open = openState(section);
    // A hatch lock token is read for the Remote Start preparation only; doorsLocked still counts doors alone.
    const locked = kind === 'door' || kind === 'trunk' ? lockState(section) : null;
    const existing = byKey.get(key);
    if (existing) {
      existing.open = mergeTri(existing.open, open, true);
      existing.locked = mergeTri(existing.locked, locked, false);
    } else {
      byKey.set(key, { key, kind, label, open, locked });
    }
  }
  const openings = [...byKey.values()];
  const lockStates = openings.filter((o) => o.kind === 'door').map((o) => o.locked);
  let doorsLocked: boolean | null = null;
  if (lockStates.length > 0) {
    if (lockStates.includes(false)) {
      doorsLocked = false;
    } else if (lockStates.every((s) => s === true)) {
      doorsLocked = true;
    }
  }
  const location = parseLocation(data);
  return { openings, doorsLocked, ...reportTime(data), ...(location ? { location } : {}) };
}

const REPORT_TIME_ROOTS: string[][] = [[], ['payload'], ['status', 'payload'], ['vehicleStatusResponse', 'payload'], ['data']];
/** 2000-01-01: anything earlier is a counter or an unset value, not a report time. */
const EARLIEST_REPORT_MS = 946_684_800_000;

/**
 * The moment the vehicle itself uploaded the report, from the fields RedLink
 * verified (`occurrenceDate`, then `lastTimestamp`). The envelope's own
 * `timestamp` is Toyota's processing time and is never read.
 */
export function reportTime(data: unknown, now: number = Date.now()): { reportedAt?: string; reportedAtMs?: number } {
  for (const root of REPORT_TIME_ROOTS) {
    for (const key of ['occurrenceDate', 'lastTimestamp']) {
      const value = at(data, ...root, key);
      let ms: number | undefined;
      if (typeof value === 'string' && value.trim() !== '') {
        ms = Date.parse(value);
      } else if (typeof value === 'number') {
        ms = value > 10_000_000_000 ? value : value * 1000;
      } else {
        continue;
      }
      const text = String(value).trim();
      // Allow a few minutes of clock skew between Toyota and this host.
      if (ms !== undefined && Number.isFinite(ms) && ms > EARLIEST_REPORT_MS && ms <= now + 5 * 60_000) {
        return { reportedAt: text, reportedAtMs: ms };
      }
      return { reportedAt: text };
    }
  }
  return {};
}

/* -------------------------------------------------------------------------- */
/* EV status                                                                  */
/* -------------------------------------------------------------------------- */

export interface ElectricStatus {
  /** 0 to 100, or undefined when Toyota reported nothing valid. */
  batteryPercent?: number;
  /** undefined when the state cannot be determined. */
  charging?: boolean;
  /** When the vehicle uploaded this EV snapshot (`vehicleInfo.acquisitionDatetime`). It is separate from the door report. */
  reportedAt?: string;
  reportedAtMs?: number;
}

const STOPPED_SIGNALS = ['not', 'no_', 'complete', 'completed', 'park', 'idle', 'standby', 'disconnected', 'unplugged', 'finish', 'stopped'];
const ACTIVE_SIGNALS = ['charging', 'charge now', 'in_progress', 'in progress', 'active', 'normal_charge'];

export function percentage(value: number | undefined): number | undefined {
  return value !== undefined && value >= 0 && value <= 100 ? value : undefined;
}

export function parseElectricStatus(data: unknown, now: number = Date.now()): ElectricStatus {
  const chargeInfo = at(data, 'vehicleInfo', 'chargeInfo') ?? at(data, 'payload', 'vehicleInfo', 'chargeInfo');
  // RedLink's verified EV report field; reportTime applies the same date rules as the door report.
  const acquired = at(data, 'vehicleInfo', 'acquisitionDatetime') ?? at(data, 'payload', 'vehicleInfo', 'acquisitionDatetime');
  const time = acquired === undefined ? {} : reportTime({ occurrenceDate: acquired }, now);
  if (!isObject(chargeInfo)) {
    return { ...time };
  }
  const batteryPercent = percentage(num(chargeInfo['chargeRemainingAmount']));
  const named = str(chargeInfo['connectorStatus']) ?? str(chargeInfo['chargeType']);
  let charging: boolean | undefined;
  if (named && Number.isNaN(Number(named))) {
    const n = named.toLowerCase();
    if (STOPPED_SIGNALS.some((s) => n.includes(s))) {
      charging = false;
    } else if (ACTIVE_SIGNALS.some((s) => n.includes(s))) {
      charging = true;
    }
  } else if (chargeInfo['connectorStatus'] !== undefined || chargeInfo['chargeType'] !== undefined) {
    // The 21MM bZ sends undocumented numeric codes; a positive remaining-time
    // estimate is the evidence RedLink uses; zero or the 65535 sentinel means not charging.
    const remaining = num(chargeInfo['remainingChargeTime']);
    if (remaining !== undefined && remaining >= 0) {
      charging = remaining > 0 && remaining < 65535;
    }
  }
  return { batteryPercent, charging, ...time };
}

/* -------------------------------------------------------------------------- */
/* Engine / climate                                                           */
/* -------------------------------------------------------------------------- */

export interface Telemetry {
  /** Vehicle speed as Toyota reports it; 0 means stopped. Undefined when not reported. */
  speed?: number;
  reportedAt?: string;
  reportedAtMs?: number;
}

/**
 * Telemetry speed, RedLink's `observedSpeed` paths (`speed.value`, `speed`,
 * `vehicleSpeed.value`, `vehicleSpeed`), with the report time from `lastTimestamp`.
 */
export function parseTelemetry(data: unknown, now: number = Date.now()): Telemetry {
  for (const root of [['payload'], []]) {
    const base = at(data, ...root);
    if (!isObject(base)) {
      continue;
    }
    let speed: number | undefined;
    for (const path of [['speed', 'value'], ['speed'], ['vehicleSpeed', 'value'], ['vehicleSpeed']]) {
      const value = num(at(base, ...path));
      if (value !== undefined && Number.isFinite(value) && value >= 0) {
        speed = value;
        break;
      }
    }
    const time = reportTime(base, now);
    if (speed !== undefined || time.reportedAt !== undefined) {
      return { ...(speed !== undefined ? { speed } : {}), ...time };
    }
  }
  return {};
}

export function parseEngineRunning(data: unknown): boolean | undefined {
  const running = bool(at(data, 'running'));
  if (running !== undefined) {
    return running;
  }
  const status = str(at(data, 'status'));
  return status === undefined ? undefined : status === '1';
}

export function parseClimateRunning(data: unknown): boolean | undefined {
  return bool(at(data, 'isRunning')) ?? bool(at(data, 'running'));
}

/* -------------------------------------------------------------------------- */
/* Remote capability matching (port of RedLink's word-run rules)               */
/* -------------------------------------------------------------------------- */

const NEGATION_WORDS = new Set(['no', 'non', 'not', 'without', 'unavailable']);

/** Splits `doorLockUnlockCapable` into lowercase words on case and separator boundaries. */
function capabilityWords(name: string): string[] {
  const words: string[] = [];
  let current = '';
  let previous = '';
  for (const character of name) {
    if (!/[A-Za-z0-9]/.test(character)) {
      if (current !== '') {
        words.push(current);
        current = '';
      }
      previous = '';
      continue;
    }
    const upper = /[A-Z]/.test(character);
    const lower = /[a-z]/.test(character);
    if (previous !== '' && upper && /[a-z]/.test(previous) && current !== '') {
      words.push(current);
      current = '';
    } else if (previous !== '' && lower && /[A-Z]/.test(previous) && current.length > 1) {
      // "HVACControl" splits as HVAC + Control: the last uppercase letter starts the next word.
      const leading = current.slice(-1);
      words.push(current.slice(0, -1));
      current = leading;
    }
    current += character.toLowerCase();
    previous = character;
  }
  if (current !== '') {
    words.push(current);
  }
  return words;
}

/** Every contiguous run of the name's words, concatenated, so `moonRoofCapable` yields `moonroof`. */
function capabilityRuns(name: string): Set<string> {
  const words = capabilityWords(name);
  const runs = new Set<string>([name.toLowerCase().replace(/[^a-z0-9]/g, '')]);
  for (let start = 0; start < words.length; start++) {
    let run = '';
    for (const word of words.slice(start)) {
      run += word;
      runs.add(run);
    }
  }
  return runs;
}

/**
 * True when a reported capability name matches one of the needles and is not a
 * negated name (`noMoonroof`). Absent or unrecognized names are not support:
 * RedLink keeps optional controls hidden until the vehicle proves them.
 */
export function hasRemoteCapability(capabilities: readonly string[], ...needles: string[]): boolean {
  const wanted = needles.map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, '')).filter((n) => n !== '');
  let positive = false;
  for (const name of capabilities) {
    const runs = capabilityRuns(name);
    if (!wanted.some((n) => runs.has(n))) {
      continue;
    }
    if (!capabilityWords(name).some((w) => NEGATION_WORDS.has(w))) {
      positive = true;
    }
  }
  return positive;
}

export interface PrepareCapabilities {
  closeWindows: boolean;
  closeMoonroof: boolean;
  lockTrunk: boolean;
}

/**
 * Which Remote Start preparation commands this vehicle supports, gated as
 * RedLink gates `power-window-close`, `sunroof-close` and `trunk-lock`:
 * not on 17CY, and only when an enabled capability name matches.
 */
export function prepareCapabilities(vehicle: Pick<VehicleSummary, 'capabilities' | 'modelName' | 'nickname'>, generation: Generation): PrepareCapabilities {
  if (generation === '17CY') {
    return { closeWindows: false, closeMoonroof: false, lockTrunk: false };
  }
  const identity = `${vehicle.modelName ?? ''} ${vehicle.nickname ?? ''}`.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  // RedLink treats every bZ as having no remote moonroof command.
  const bZ = identity.includes('bz');
  return {
    closeWindows: hasRemoteCapability(vehicle.capabilities, 'window'),
    closeMoonroof: !bZ && hasRemoteCapability(vehicle.capabilities, 'sunroof', 'moonroof', 'moon_roof'),
    lockTrunk: hasRemoteCapability(vehicle.capabilities, 'trunk', 'hatch', 'backdoor', 'back_door', 'tailgate', 'liftgate'),
  };
}
