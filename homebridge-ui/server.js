'use strict';

// Homebridge custom settings UI server. All Toyota logic lives in dist/ui.js
// (built from src/ui.ts) so it can be unit tested; this file only wires it up.
const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');
const { SignInService } = require('../dist/ui');

class ToyotaUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    const service = new SignInService({
      storagePath: this.homebridgeStoragePath,
      configPath: this.homebridgeConfigPath,
      fetchFn: fetch,
    });
    this.onRequest('/status', () => service.status());
    this.onRequest('/start', () => service.start());
    this.onRequest('/verify', (payload) => service.verify(payload && payload.code));
    this.ready();
  }
}

(() => new ToyotaUiServer())();
