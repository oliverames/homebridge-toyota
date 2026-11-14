import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLATFORM_NAME } from '../src/settings';

const schema = JSON.parse(readFileSync(join(__dirname, '..', 'config.schema.json'), 'utf8')) as {
  pluginAlias: string;
  schema: { properties: Record<string, { default?: unknown; minimum?: number; properties?: Record<string, { default?: unknown }> }> };
};

describe('config.schema.json', () => {
  it('matches the registered platform name', () => {
    expect(schema.pluginAlias).toBe(PLATFORM_NAME);
  });
  it('declares every key parseConfig reads, with safe defaults', () => {
    const p = schema.schema.properties;
    for (const key of ['username', 'password', 'apiKey', 'oneTimePasscode', 'vin', 'generation', 'pollIntervalMinutes', 'exposeOpenings', 'exposeBattery', 'remoteStart', 'graphqlApiKey', 'appVersion']) {
      expect(p[key], key).toBeDefined();
    }
    expect(p['pollIntervalMinutes']?.default).toBe(5);
    expect(p['pollIntervalMinutes']?.minimum).toBe(5);
    expect(p['remoteStart']?.properties?.['enabled']?.default).toBe(false);
  });
  it('ships no key or credential defaults', () => {
    for (const key of ['username', 'password', 'apiKey', 'graphqlApiKey']) {
      expect(schema.schema.properties[key]?.default, key).toBeUndefined();
    }
  });
});
