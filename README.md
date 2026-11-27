<p align="center">
  <img src="assets/icon.svg" width="80" height="80" alt="Homebridge Toyota">
</p>

<h1 align="center">Homebridge Toyota</h1>

<p align="center">
  <strong>Your Toyota in the Home app as a real lock, real sensors and a real battery, with no fake accessories.</strong>
</p>

<p align="center">
  <code>Toyota North America</code> &bull;
  <code>17CY to 24MM vehicles</code> &bull;
  <code>Homebridge 1.8 and 2.x</code> &bull;
  <code>132 tests</code>
</p>

<p align="center">
  <a href="https://github.com/oliverames/homebridge-toyota/releases/latest">
    <img src="https://img.shields.io/github/v/release/oliverames/homebridge-toyota?style=flat-square&color=f5a542" alt="Release">
  </a>
  <a href="https://github.com/oliverames/homebridge-toyota/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/oliverames/homebridge-toyota/ci.yml?branch=main&style=flat-square&color=f5a542&label=CI" alt="CI">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-f5a542?style=flat-square" alt="License">
  </a>
  <a href="https://www.buymeacoffee.com/oliverames">
    <img src="https://img.shields.io/badge/Buy_Me_a_Coffee-support-f5a542?style=flat-square&logo=buy-me-a-coffee&logoColor=white" alt="Buy Me a Coffee">
  </a>
</p>

---

Homebridge Toyota is a Homebridge platform plugin that puts a Toyota North America vehicle into Apple HomeKit using services HomeKit already understands: a lock for the doors, a contact sensor for each opening the car reports, and a battery for an EV. Ask Siri whether the car is locked, get a Home notification when the hatch is left open, or lock it from Control Center. It talks to Toyota's Connected Services API (the backend behind the Toyota app) and handles the emailed sign-in code from the Homebridge settings page.

Unofficial. Not affiliated with, endorsed by, or supported by Toyota.

## Why this exists

The Toyota app knows whether your doors are locked, but HomeKit doesn't, so the car sits outside every scene, automation and "is everything locked?" check you've built for the house. Existing car bridges tend to fill that gap with switches and fake lights that clutter the Home app and confuse Siri.

This plugin takes the opposite approach. Every accessory maps to a native HomeKit service with honest state:

- **Unknown stays unknown.** If Toyota hasn't reported a lock state, HomeKit says so instead of guessing.
- **Commands are confirmed, not assumed.** After a lock or start, the plugin waits for the vehicle's next report before HomeKit changes state.
- **The car is never woken up.** It reads Toyota's cached report, which protects the 12 V battery and Toyota's rate limits.
- **Remote Start is the one exception.** HomeKit has no remote-start service, so it's an opt-in switch, off by default.

The client logic is a TypeScript port of the Toyota module in RedLink, my iOS Toyota app, so the endpoints, headers and parsing rules come from code that already runs against Toyota's API every day.

## Quick start

Requires Homebridge `^1.8.0 || ^2.0.0`, Node `^22 || ^24`, and a Toyota North America account with the vehicle linked. Remote lock and start need a Remote Connect subscription.

Install the latest release where Homebridge runs:

```sh
npm install -g https://github.com/oliverames/homebridge-toyota/releases/download/v0.3.4/homebridge-toyota-0.3.4.tgz
```

Then add the platform in the Homebridge UI, or in `config.json`:

```json
{
  "platform": "Toyota",
  "name": "Toyota",
  "username": "you@example.com",
  "password": "your Toyota password",
  "apiKey": "current OneApp client key",
  "remoteStart": { "enabled": true },
  "_bridge": { "username": "0E:12:34:56:78:9A", "port": 36422 }
}
```

Open the plugin's settings page, click **Sign in / Send code**, enter the code Toyota emails you, and click **Verify**. The plugin picks up the session within 30 seconds, without a restart.

## What it adds to HomeKit

| Toyota data | HomeKit service | Notes |
| --- | --- | --- |
| Door locks | Lock Mechanism "Doors" | Real lock state. Lock and unlock send the remote command and confirm from the vehicle's next report. |
| Doors, trunk or hatch, hood, windows, moonroof | One Contact Sensor each | Only for openings the vehicle reports a position for. |
| EV charge level | Battery "EV Battery" | Includes low battery and charging. Fuel level is never exposed. |
| Remote Start (opt-in) | Switch "Remote Start" | Off by default. Prepares the vehicle first; see below. |

Run the plugin in its own [child bridge](https://github.com/homebridge/homebridge/wiki/Child-Bridges) (the `_bridge` block above) so a Toyota outage or restart never touches your other accessories.

## Remote Start that gets the car ready first

Turning on the Remote Start switch doesn't just fire the engine. It makes sure the car is in a state you'd want to start it in. Each step is skipped when the vehicle already satisfies it:

1. **Check.** If a door, the hood, or the hatch is physically open, nothing is sent and the switch returns to off. The log says which one.
2. **Lock** the doors if any are unlocked.
3. **Close** open windows and the moonroof, and lock the hatch, when the vehicle reports those remote capabilities. These commands don't exist on 17CY vehicles.
4. **Confirm** each step from the vehicle's next reports before moving on. A refused or ineffective step abandons the start, with the reason in the log.
5. **Start** the engine. Climate uses whatever is saved in the Toyota app.

Set `remoteStart.prepare` to `false` to start immediately instead. Toyota allows about two remote starts per ignition cycle.

## Configuration

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `username` | Yes | (none) | Toyota account email. |
| `password` | Yes | (none) | Toyota account password. |
| `apiKey` | Yes | (none) | Toyota OneApp client key, sent as `X-API-KEY`. Not bundled; see below. |
| `vin` | No | all vehicles | Expose only this VIN. |
| `generation` | No | reported by Toyota, else `21MM` | `17CY`, `17CYPLUS`, `21MM` or `24MM`. |
| `pollIntervalMinutes` | No | `5` | Minimum 5. Backs off automatically on errors. |
| `autoLock.enabled` | No | `false` | Lock the doors when they have been reported unlocked for `autoLock.afterMinutes` (default 10) with the car parked, closed and idle. See the design notes for its limits. |
| `wakeOnHomeAppOpen` | No | `true` | When the Home app shows the car and its report is 15+ minutes old, ask the car for a fresh one. At most eight a day. |
| `staleReportHours` | No | `3` | Once Toyota's report from the car is this many hours old, ask the car for a fresh one, at most once per this interval. Each request wakes the car. Minimum 3; `0` turns it off. |
| `exposeOpenings` | No | `true` | Contact sensors for doors, windows, trunk, hood and moonroof. |
| `exposeBattery` | No | `true` | Battery service when a charge level is reported. |
| `remoteStart.enabled` | No | `false` | Adds the Remote Start switch. |
| `remoteStart.prepare` | No | `true` | Lock, close and check the vehicle before starting. |
| `graphqlApiKey` | 24MM only | (none) | AppSync key for 24MM remote commands. |
| `oneTimePasscode` | No | (none) | Fallback when the settings page isn't available. Clear it after use. |
| `appVersion` | No | `3.5.0` | `X-APPVERSION` header. |

### The client key

Toyota rotates the OneApp client key every few months. When it does, sign-in still works but every request returns `APIGW-403`. Once that has survived three fresh sign-ins in a row (a single 403 can be a passing Toyota outage), the log says the key has most likely been rotated. The current value can be read from the Toyota OneApp Android APK (decompile it with a tool such as jadx and look at `NetworkDataProviderIml.apiKey()`). Paste it into `apiKey` and restart the child bridge. No plugin release is needed.

### Signing in

Toyota may email a one-time code the first time you sign in. The settings page handles it without restarts: save your email, password and key, click **Sign in / Send code**, enter the code, and click **Verify**. Keep the page open between the two steps, because the pending challenge lives in its memory. The session is saved to `<Homebridge storage>/homebridge-toyota/session.json` with owner-only permissions and refreshes silently after that. The page never displays your password, key, tokens or code.

## Behavior and limits

- **Data is Toyota's cached report.** Between the car's own uploads, lock state can be hours old on a parked car. The plugin asks the car for a fresh report once the last one is 3 hours old (`staleReportHours`), and logs each lock change with the time the car sent it.
- **Failures back off.** Polling backs off up to an hour, and an HTTP 429 waits at least 15 minutes. Wrong credentials or a pending code pause polling until you sign in again.
- **Refusals are explained.** When Toyota rejects a command, the log shows Toyota's own reason with tokens and VINs removed.
- **Not supported:** location, fuel level, tire pressure, trips, climate settings, hazards, horn and charging control. [docs/design.md](docs/design.md) explains each decision.

**Verified live** (November 2026, 21MM bZ): sign-in with an emailed code, status polling, door lock, engine start and engine stop. The window, moonroof and hatch preparation commands and 24MM vehicles are implemented from Toyota's API but not yet confirmed on a real car. Reports from other models are welcome in [Issues](https://github.com/oliverames/homebridge-toyota/issues).

## Architecture

```
src/
  auth.ts        ForgeRock login, emailed-code challenge, token refresh
  client.ts      Request headers, routes, refresh-and-retry, 24MM GraphQL commands
  envelope.ts    Response envelope and Toyota success-code rules
  parse.ts       Vehicle list, door and opening status, EV status, capabilities
  state.ts       Pure mapping from Toyota data to HomeKit values
  controller.ts  Poll, command and Remote Start preparation logic (no HomeKit imports)
  poller.ts      Backoff and the poll loop
  ui.ts          Sign-in handlers behind the settings page
  accessory.ts   HomeKit services
  platform.ts    Homebridge platform, discovery, accessory lifecycle
homebridge-ui/
  server.js           Custom settings UI server
  public/index.html   Sign in / Send code, Verify, and session status
```

The controller has no HomeKit imports, so the vehicle logic is tested on its own against a stateful fake vehicle. The full reasoning, including the options that were rejected, is in [docs/design.md](docs/design.md).

## Development

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm pack        # produces the installable tarball
```

Tests use mocked `fetch` and synthetic payloads and never contact Toyota. CI runs the same steps on Node 22 and 24 for every push to `main`.

---

<p align="center">
  <a href="https://www.buymeacoffee.com/oliverames">
    <img src="https://img.shields.io/badge/Buy_Me_a_Coffee-support-f5a542?style=for-the-badge&logo=buy-me-a-coffee&logoColor=white" alt="Buy Me a Coffee">
  </a>
</p>

<p align="center">
  <sub>
    Built by <a href="https://ames.consulting">Oliver Ames</a> in Vermont
    &bull; <a href="https://github.com/oliverames">GitHub</a>
    &bull; <a href="https://linkedin.com/in/oliverames">LinkedIn</a>
    &bull; <a href="https://bsky.app/profile/oliverames.bsky.social">Bluesky</a>
  </sub>
</p>

<p align="center">
  <sub>Toyota is a trademark of Toyota Motor Corporation, used here only to describe compatibility.</sub>
</p>
