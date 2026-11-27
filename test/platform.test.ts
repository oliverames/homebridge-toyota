import { describe, expect, it } from 'vitest';
import { HomebridgeAPI } from 'homebridge/lib/api';
import type { API, Logging, PlatformConfig } from 'homebridge';
import { ToyotaPlatform } from '../src/platform';

const log = { info() {}, warn() {}, error() {}, debug() {}, log() {}, success() {} } as unknown as Logging;

describe('cached accessories before Toyota answers', () => {
  it('a restored lock or switch answers No Response to writes instead of silently dropping them', async () => {
    const api = new HomebridgeAPI() as unknown as API;
    const platform = new ToyotaPlatform(log, { platform: 'Toyota', username: 'u@example.com', password: 'p', apiKey: 'k' } as PlatformConfig, api);
    const accessory = new api.platformAccessory('Odysseus', api.hap.uuid.generate('cached'));
    const lock = accessory.addService(api.hap.Service.LockMechanism, 'Doors');
    const remote = accessory.addService(api.hap.Service.Switch, 'Remote Start', 'remote-start');
    platform.configureAccessory(accessory);
    await expect(lock.getCharacteristic(api.hap.Characteristic.LockTargetState).handleSetRequest(0)).rejects.toBeDefined();
    await expect(remote.getCharacteristic(api.hap.Characteristic.On).handleSetRequest(true)).rejects.toBeDefined();
  });
});
