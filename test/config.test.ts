import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';

const base = { username: 'a@b.c', password: 'pw', apiKey: 'k' };

describe('parseConfig', () => {
  it('requires username, password and apiKey', () => {
    const r = parseConfig({});
    expect(r.config).toBeUndefined();
    expect(r.errors).toHaveLength(3);
  });
  it('defaults are conservative and optional features are off', () => {
    const c = parseConfig(base).config!;
    expect(c).toMatchObject({ pollIntervalMinutes: 5, exposeOpenings: true, exposeBattery: true, remoteStartEnabled: false });
  });
  it('never polls faster than 5 minutes', () => {
    const r = parseConfig({ ...base, pollIntervalMinutes: 1 });
    expect(r.config?.pollIntervalMinutes).toBe(5);
    expect(r.warnings).toHaveLength(1);
    expect(parseConfig({ ...base, pollIntervalMinutes: 15 }).config?.pollIntervalMinutes).toBe(15);
  });
  it('remote start is opt-in', () => {
    expect(parseConfig({ ...base, remoteStart: { enabled: true } }).config?.remoteStartEnabled).toBe(true);
    expect(parseConfig({ ...base, remoteStart: {} }).config?.remoteStartEnabled).toBe(false);
  });
  it('prepares the vehicle before Remote Start unless told not to', () => {
    expect(parseConfig({ ...base, remoteStart: { enabled: true } }).config?.remoteStartPrepare).toBe(true);
    expect(parseConfig(base).config?.remoteStartPrepare).toBe(true);
    expect(parseConfig({ ...base, remoteStart: { enabled: true, prepare: false } }).config?.remoteStartPrepare).toBe(false);
  });
  it('validates generation and normalizes VIN', () => {
    expect(parseConfig({ ...base, generation: 'bogus' }).errors).toHaveLength(1);
    const c = parseConfig({ ...base, generation: '24mm', vin: ' abc ' }).config!;
    expect(c.generation).toBe('24MM');
    expect(c.vin).toBe('ABC');
  });
});
