# homebridge-toyota

Private Homebridge platform plugin that exposes a Toyota North America vehicle to Apple HomeKit using native services only: a real door lock, contact sensors for doors, windows, trunk and hood, and the EV battery. It talks to Toyota's OneApp Connected Services API using the same client logic as [RedLink](https://github.com/oliverames/redlink), ported to TypeScript.

Unofficial and not affiliated with Toyota. Private repository, not published to npm.

## What it adds to HomeKit

| Toyota data | HomeKit service | Notes |
| --- | --- | --- |
| Door locks | Lock Mechanism "Doors" | Real lock state. Unknown stays unknown. Lock and unlock send the remote command and confirm from the vehicle's next report. |
| Doors, trunk or hatch, hood, windows, moonroof | One Contact Sensor each | Only for openings the vehicle reports a position for. |
| EV charge level | Battery "EV Battery" | Only when Toyota reports a charge level. Includes low battery and charging. Gas level is never exposed. |
| Remote start (opt-in) | Switch "Remote Start" | Off by default. The one non-native service, because HomeKit has no remote-start type. By default it prepares the vehicle first; see below. |

The reasoning and the options that were rejected are in [docs/design.md](docs/design.md).

## Requirements

- Homebridge `^1.8.0 || ^2.0.0`, Node `^22 || ^24`.
- A Toyota North America account with the vehicle linked.
- A Toyota Remote Connect subscription for remote lock, unlock and start. Status-only use may work without one, which is unverified. The plugin logs the subscriptions Toyota reports at startup.
- The current OneApp client key (see below).

## Install

The repository is private, so install from a local checkout or a packed tarball, not npm:

```sh
git clone https://github.com/oliverames/homebridge-toyota.git
cd homebridge-toyota
npm ci && npm run build && npm pack
# then, where Homebridge runs:
npm install -g ./homebridge-toyota-0.3.0.tgz
```

## Configure

Use the Homebridge UI (the plugin ships `config.schema.json`) or edit `config.json`:

```json
{
  "platform": "Toyota",
  "name": "Toyota",
  "username": "you@example.com",
  "password": "your Toyota password",
  "apiKey": "current OneApp client key",
  "_bridge": { "username": "0E:12:34:56:78:9A", "port": 36422 }
}
```

### Run it in a child bridge

Run this plugin in its own child bridge so a Toyota outage or restart never touches your other accessories. In the Homebridge UI open the plugin's menu and choose Bridge Settings, then enable the child bridge. Or add a `_bridge` block as above with a unique MAC-style `username` and a free `port`. Add the child bridge's accessory to HomeKit with its own pairing code. Restart the child bridge after changing the config.

### Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `username` | Yes | none | Toyota account email. |
| `password` | Yes | none | Toyota account password. |
| `apiKey` | Yes | none | OneApp public client key sent as `X-API-KEY`. Not bundled with the plugin. |
| `oneTimePasscode` | No | none | Fallback only. Prefer the Sign in button on the settings page. See below. Clear it afterwards. |
| `vin` | No | all vehicles | Expose only this VIN. |
| `generation` | No | reported by Toyota, else `21MM` | `17CY`, `17CYPLUS`, `21MM` or `24MM`. |
| `pollIntervalMinutes` | No | `5` | Minimum 5. Backs off automatically on errors. |
| `exposeOpenings` | No | `true` | Contact sensors for doors, windows, trunk, hood and moonroof. |
| `exposeBattery` | No | `true` | Battery service when a charge level is reported. |
| `remoteStart.enabled` | No | `false` | Adds the Remote Start switch. |
| `remoteStart.prepare` | No | `true` | Prepare the vehicle before starting (lock, close, check). Set to `false` to start immediately. |
| `graphqlApiKey` | 24MM only | none | AppSync key for 24MM remote commands. |
| `appVersion` | No | `3.5.0` | `X-APPVERSION` header. |

### Getting and rotating the client key

Toyota rotates the OneApp key every few months. The symptom is that sign-in works but every request returns `APIGW-403`, and the log says the client key has most likely been rotated. To get the new key, follow the `refresh-toyota-api-key` skill in `personal-plugins` (extract it from the OneApp APK), or copy it from RedLink's `ToyotaEndpointProfile.northAmerica`. Paste it into `apiKey` and restart the child bridge. No plugin release is needed.

### Signing in from the settings page

Toyota may email a one-time code the first time you sign in. Handle it without restarts:

1. Open the plugin's settings in Homebridge, enter your email, password and client key, and click Save. Sign-in uses the saved settings.
2. Click **Sign in / Send code**. Toyota emails a code.
3. Enter the code and click **Verify**. The status line shows the account, the number of vehicles and when the session was last updated.

Verifying writes `<Homebridge storage>/homebridge-toyota/session.json` (owner-only permissions), the same file the plugin uses. A running plugin picks up the new session on its next update or command, and resumes updates if it had paused for a sign-in problem (it checks every 30 seconds). No restart is needed. The code is held in memory by the settings page, so keep that page open between sending and verifying. A code is treated as valid for about 10 minutes; that limit is a conservative guess, not a measured Toyota timeout, so if Verify fails just click Sign in / Send code again. The page never shows your password, key, tokens or code.

If the settings page is not available, use the fallback: start the plugin once so Toyota sends the code, enter it in `oneTimePasscode`, save, and restart within 10 minutes. Clear the field afterwards. Once a session is saved it refreshes silently.

## Remote Start preparation

With the Remote Start switch enabled, turning it on first prepares the vehicle (turn this off with `remoteStart.prepare: false`). The steps are sequential and each one is skipped when the vehicle already satisfies it:

1. Read the vehicle status. If any door, the hood or the hatch or trunk is physically open, nothing is sent. The log says which one, and the switch returns to off.
2. If a door is unlocked, send `door-lock`.
3. If a window is open and the vehicle reports a window capability, send `power-window-close`. Same for an open moonroof (`sunroof-close`, moonroof capability, never on a bZ). If the hatch or trunk reports an unlocked state and the vehicle reports a hatch or trunk capability, send `trunk-lock`. These three commands do not exist on 17CY. Without the capability the step is skipped with a log note and the start goes ahead.
4. Each command is confirmed from the next status reads (up to three, 10 seconds apart, the same as a lock) before the next step. If a step is refused, errors, or does not take effect, the start is abandoned and the log gives the reason. A rate limit on a read also stops it rather than retrying.
5. Then it starts the engine, or climate on an EV.

This works from Toyota's last stored report. The plugin never wakes the vehicle, so on a car that has not reported recently the preparation may act on old information, and a start can wait on a slow report.

## Behaviour and limits

- Data is Toyota's cached report. The plugin never wakes the vehicle, so lock state can be hours old on a parked car. This protects the 12 V battery and Toyota's rate limits.
- After a command the plugin reads status up to three times, 10 seconds apart. If the vehicle has not reported the change, HomeKit returns to the reported state and the log says why.
- API failures are caught and logged. Polling backs off up to one hour, and a 429 waits at least 15 minutes. Wrong credentials or a pending passcode pause polling until you sign in from the settings page or restart.
- Tokens are saved in `<Homebridge storage>/homebridge-toyota/session.json` with owner-only permissions. Credentials and the key sit in `config.json` like any Homebridge plugin.
- Not supported: location, fuel level, tire pressure, trips, climate temperature, hazards, horn and charging control. See [docs/design.md](docs/design.md) for why.
- When Toyota refuses a command, the log shows Toyota's own reason when its response includes one (secrets and VINs removed). Debug logging also shows the header names and body of each command sent.
- Nothing was verified against a live vehicle at the time of writing.

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Tests use mocked `fetch` and synthetic payloads. They never contact Toyota. CI runs the same steps on every push to `main`.

```
src/
  auth.ts        ForgeRock login, OTP challenge, token refresh
  client.ts      Request headers, routes, refresh-and-retry, GraphQL command
  envelope.ts    Response envelope and Toyota success-code rules
  parse.ts       Vehicle list, door and opening status, EV status
  state.ts       Pure mapping to HomeKit values
  controller.ts  Poll and command logic per vehicle (no HomeKit imports)
  poller.ts      Backoff and the poll loop
  ui.ts          Sign-in handlers for the settings page (homebridge-ui/server.js wraps them)
homebridge-ui/
  server.js      Custom settings UI server
  public/index.html  Sign in / Send code, Verify and status line
  accessory.ts   HomeKit services
  platform.ts    Homebridge platform, discovery, accessory lifecycle
```

## Provenance

Endpoints, headers and parsing rules come from RedLink's `ToyotaKit` and its Toyota APK research. Toyota names are used only to describe compatibility. Author: Oliver Ames.
