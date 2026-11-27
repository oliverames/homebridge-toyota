import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PLATFORM_NAME = 'Toyota';
export const PLUGIN_NAME = 'homebridge-toyota';

export const AUTH_BASE = 'https://login.toyotadriverslogin.com';
export const REALM_PATH = '/oauth2/realms/root/realms/tmna-native';
export const ACCESS_TOKEN_URL = `${AUTH_BASE}${REALM_PATH}/access_token`;
export const AUTHORIZE_URL = `${AUTH_BASE}${REALM_PATH}/authorize`;
export const AUTHENTICATE_URL = `${AUTH_BASE}/json/realms/root/realms/tmna-native/authenticate`;
export const OAUTH_CLIENT_ID = 'oneappsdkclient';
export const OAUTH_REDIRECT_URI = 'com.toyota.oneapp:/oauth2Callback';

export const API_GATEWAY = 'https://onecdn.telematicsct.com/oneapi/';
export const SERVICES_GATEWAY = 'https://onecdn.telematicsct.com/';
export const GRAPHQL_ENDPOINT = 'https://oa-api.telematicsct.com/graphql';

// Header values that describe the OneApp client being emulated. These are not
// secrets. The X-API-KEY client key is deliberately NOT here: it is user config.
export const DEFAULT_APP_VERSION = '3.5.0';

/** This plugin's version, shown as the accessory's firmware revision in the Home app. */
export const PLUGIN_VERSION: string = (() => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    const version = typeof parsed === 'object' && parsed !== null ? (parsed as { version?: unknown }).version : undefined;
    return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
