# Design

This plugin exposes a Toyota North America vehicle to HomeKit using only services HomeKit already defines. The Toyota side is a TypeScript port of the client logic in RedLink, the author's iOS Toyota app (its `ToyotaKit` module). Live verification is limited; see "Verification status" at the end.

## HomeKit mapping

The rule is native-only: no lights, switches or outlets standing in for something else, and nothing that duplicates a device HomeKit already has.

| Vehicle fact | HomeKit service | Source | Notes |
| --- | --- | --- | --- |
| Door lock state, lock and unlock | `LockMechanism` ("Doors") | Remote status, `door-lock` and `door-unlock` commands | Current state is `SECURED` only when every door that reports a lock token is locked, `UNSECURED` if any is unlocked, and `UNKNOWN` otherwise. A closed door is never read as a locked door (RedLink fixed that bug). |
| Each door, trunk or hatch, hood, window and moonroof position | One `ContactSensor` per reported opening | Remote status | Closed is `CONTACT_DETECTED`. An opening that reports no position gets no sensor. On by default, `exposeOpenings: false` removes them. |
| EV high-voltage battery level, low state, charging | `Battery` ("EV Battery") | EV status | Created only when Toyota returns a valid state of charge. `StatusLowBattery` at 20% or below. `ChargingState` is `CHARGING` or `NOT_CHARGING`. |
| Remote start (optional) | `Switch` ("Remote Start") | `engine-start`/`engine-stop` (including 21MM EVs, live-verified on a bZ), or `startClimate`/`stopClimate` on 24MM EVs (unverified) | Off by default and the only non-native service. State follows engine or climate status. See below. |

### The one exception: Remote Start

HomeKit has no remote-start, ignition or preconditioning type. A `Switch` is the least misleading stand-in, it is opt-in (`remoteStart.enabled`, default `false`), the schema says what it does, and it is named "Remote Start" so Siri and automations cannot confuse it with a light or outlet. On an EV the switch starts and stops climate (RedLink's `climateOn`/`climateOff`, 68 F auto) because that is the remote-start equivalent. On other vehicles it sends `engine-start` and `engine-stop`. The switch reflects reported state, not the request, and returns to the reported state if the vehicle does not confirm.

#### Preparing the vehicle first

Remote start with the car unlocked or a window down is easy to do by accident, so by default (`remoteStart.prepare`, on) the controller prepares the vehicle before it sends the start. It reads status and then walks four checks in order: (1) refuse if a door, the hood or the hatch is open; (2) `door-lock` when a door reports unlocked; (3) `power-window-close` for an open window and `sunroof-close` for an open moonroof; (4) `trunk-lock` when the hatch reports an unlocked token. Every step is decided from the latest status, so a satisfied step is skipped and a second run sends nothing new. The open-opening check runs again before each step.

Each command is confirmed the way a lock is (up to six status reads at 10 second intervals, `sendAndConfirm` in `controller.ts`). A refused command, a rate limited read, a read that is still failing at the end of the window, or a command Toyota accepts that the report never shows, abandons the start with the reason, and the switch returns to off. A single 500 or 503 does not: the first status read gets one retry after 5 seconds, and a failed confirmation read is followed by the next one. Commands themselves are never resent.

Capability gating copies RedLink (`ToyotaCommandAvailability` and `supportStatus`): the commands are not offered on 17CY, a step needs an enabled capability name whose words match (`powerWindowCapable`, `moonRoofCapable`, `trunkLockUnlockCapable`, never a negated name), and every bZ is treated as having no remote moonroof command. A vehicle that does not report the capability keeps its window open or hatch unlocked, the log says so, and the start still goes ahead. Two behaviours are the plugin's own choice and not verified: the hatch lock is read from a lock token in the hatch's status section (`parse.ts` now reads it for the trunk kind while `doorsLocked` still counts doors only), so a vehicle that never reports one gets no `trunk-lock`; and preparation relies on Toyota's cached report, because the plugin never wakes the vehicle.

## Rejected options

- **Fuel level as `Battery`.** A gas tank is not a battery, and `Battery` carries low-battery and charging semantics that would be false. Fuel level is never exposed. A hybrid's traction battery is not exposed either unless Toyota reports a charge level.
- **`HeaterCooler` or `Thermostat` for climate.** Both require a current temperature. Toyota reports a target temperature and running state, not a cabin temperature, so a thermostat would show invented data.
- **Switches for hazards, horn, headlights, charging start/stop, sunroof and windows.** Momentary actions and commands with no state HomeKit models. They would be fake accessories. RedLink and Shortcuts cover them.
- **A second lock for the trunk or hatch.** Toyota does offer `trunk-lock` and `trunk-unlock` on 17CYPLUS, 21MM and 24MM, but the status payload does not reliably report a separate hatch lock token (RedLink treats a hatch as position only). A lock with no readable state would have to guess, so it is left out. This can be revisited once a live payload shows a hatch lock token.
- **`GarageDoorOpener` for the trunk.** Wrong semantics and a Siri safety prompt for the wrong thing.
- **`OccupancySensor` or presence for "driving" or "parked".** Toyota does not report occupancy. Driving is inferred from speed telemetry, which this plugin does not poll.
- **Location, odometer, tire pressure, trips, health, service history.** No HomeKit type exists, and polling the extra endpoints costs rate limit for nothing.
- **A `SecuritySystem` or `Doorbell` for alerts.** Not a fit.
- **Exposing vehicle-wake (`refresh-status`) as a button, or waking on a fixed timer.** The plugin wakes the car only when its last report is stale, at most once per interval. See "Polling".

## Authentication

Ported from `ToyotaAuthService`:

1. `POST` the ForgeRock `authenticate` endpoint, answering callbacks: `NameCallback` "User Name", `PasswordCallback` password, `ui_locales`, choice and confirmation callbacks with index 0.
2. A `PasswordCallback` titled "One Time Password" means Toyota sent a code. See below.
3. Trade the `tokenId` for an authorization code at `authorize` (cookie `iPlanetDirectoryPro`, redirects not followed, code read from the `Location` header).
4. Exchange the code at `access_token` (client `oneappsdkclient`, PKCE method `plain`).
5. Validate the `id_token` (algorithm not `none`, audience `oneappsdkclient`, not expired) and use `sub` as the GUID. The signature is not verified, matching RedLink; only the TLS response from Toyota is trusted.

Refresh tokens are single use. The client therefore refreshes inside one in-flight promise, persists the rotated session before using it, refreshes proactively when 5 minutes remain, and on a 401 or 403 refreshes once and retries once. If the saved refresh token is rejected (`invalid_grant`) it falls back to a full sign-in.

Toyota also answers 403 while its gateway is unhealthy (seen 2026-11-16 and 2026-11-17, alongside 500s and 503s), and every forced refresh is a request to the sign-in server, which answers 429 when it gets too many. So a 401 or 403 forces a refresh at most once every 5 minutes; inside that window the error is returned as is and the poller backs off. A 403 that survives a fresh refresh is reported as a probable client key rotation only after three such requests in a row, because a refreshed token proves the login is fine but one refusal does not prove the key is wrong. The settings page makes a single check, so it reports the key on the first such refusal.

### One-time passcode

Toyota may email a code on sign-in. A config change needs a restart, and a restart starts a new login that invalidates the code, so the primary flow lives in the Homebridge custom settings UI (`homebridge-ui/`, built on `@homebridge/plugin-ui-utils`).

The UI server (`homebridge-ui/server.js`, logic in `src/ui.ts`) reads the saved `username`, `password` and `apiKey` from `config.json`, so secrets never travel to the browser. **Sign in / Send code** runs `ToyotaAuth.signIn` with an in-memory challenge store. When Toyota asks for a code, the redacted challenge stays in the UI server's memory and the page shows "code sent". **Verify** calls `signIn` again with the code, which answers the held challenge rather than starting a new login. On success the UI server writes the session through `FileStore` (the same `session.json`, mode 0600, atomic) and does one vehicle-list call to confirm the key and count vehicles. Responses are a fixed whitelist of fields (configured, signed in, account email, vehicle count, session file mtime, code pending and its assumed expiry, a message); no token, password, key or code is ever returned or logged. Unknown errors are replaced by a generic message.

Handoff to the platform is the session file only:

- `ToyotaClient` remembers the session file's mtime when it reads or writes it. Each `ensureSession` compares it, and a file written by someone else (the UI server) is reloaded. Refreshes by the client itself update the remembered mtime, so they are not mistaken for outside changes.
- Wrong credentials and a pending or rejected code are `fatal` poll outcomes that stop the poller. The platform then checks `sessionFileChanged()` every 30 seconds (one `stat`) and restarts the poller with `start(0)` when a new session appears.
- After a discovery the platform writes `status.json` (vehicle count and time, no secrets) next to the session so the status line can show a count without a Toyota call.

The 10 minute limit on a held challenge (`CHALLENGE_TTL_MS`) is a conservative guess, not a measured ForgeRock timeout. The UI server keeps the challenge only in memory, so it dies with the settings page's server process; the user simply clicks Sign in / Send code again.

Fallback: the `oneTimePasscode` config field and the on-disk challenge (`pending-otp.json`, owner-only, passwords blanked) still work as before: start the plugin, receive the code, put it in the field, restart. After the session is saved Toyota should not ask again until the saved refresh token dies.

Wrong credentials, a pending code or a rejected code pause polling until a sign-in from the settings page or a restart. Retrying would send more codes or risk locking the account.

### Client key

Toyota's OneApp public client key (`X-API-KEY`) rotates every few months. It is required config (`apiKey`), is never bundled or committed, and can be changed without a release. Get the current value by decompiling the Toyota OneApp Android APK (for example with jadx) and reading `NetworkDataProviderIml.apiKey()`. Header names drift with it; they live in `buildHeaders` in `src/client.ts`. The 24MM AppSync key (`graphqlApiKey`) is separate and only used for 24MM remote commands.

## Polling and rate limits

- Default and minimum interval is 5 minutes, configurable upward. One cycle reads cached status (one `GET`), plus EV status for the battery and engine or climate status when Remote Start is enabled. Reads return what Toyota last stored and do not contact the vehicle.
- Stale reports (0.3.6). Toyota serves the car's last upload, and on 2026-11-27 the plugin started up to a 3 hour 14 minute old report. RedLink adopted automatic wakes on 2026-11-15 at the owner's request, and the plugin follows its stale-report rule (`ToyotaAutomaticWakePolicy.wakesForStaleReport`): after a successful poll, when the report's `occurrenceDate` (or `lastTimestamp`) is `staleReportHours` old (default and minimum 3, `0` turns it off) and no wake went out within that time, it sends `refresh-status` (`v1/global/remote/refresh-status` with `guid`, `deviceId` and `vin`; the legacy route on 17CY; not on 24MM, whose GraphQL mutation is unverified) and reads status for about two minutes until a newer report appears. The wake time is saved per vehicle (`wake-<VIN>.json`) before the request goes out, so a restart, failure or crash still waits a full interval; a parked car gets at most about eight wakes a day. A report with no time counts as stale, as in RedLink. The envelope's own `timestamp` is Toyota's processing time and is never read. A wake RedLink or OneApp sent shows up as a fresh report, so the plugin adds none of its own on top. `realtime-status` and the pre-wake mutation are still never called.
- Failures double the interval per consecutive failure, capped at one hour, plus up to 10% jitter. A 429 never retries sooner than 15 minutes. Sign-in problems pause polling until a new session is saved.
- Endpoints Toyota refuses for a vehicle (403 or 404 on EV status or climate status) are parked for 12 hours, as RedLink does, so a gas vehicle or an EV without climate status does not burn requests. EV status parks at once on a 400 or 404, but only after three 403s in a row, because Toyota also answers 403 during gateway outages and one stray refusal would otherwise hide the battery for 12 hours.
- Everything inside a poll or command is caught. A poll never throws, so an API failure cannot crash the child bridge. The first failure is logged at warn level, later ones at debug, and recovery is logged once.

## Commands

A HomeKit set handler has only a few seconds, but Toyota commands are asynchronous. The handler returns at once and the command runs in the background:

1. `POST` the command (REST `v1/global/remote/command` for 17CYPLUS and 21MM, the legacy `code/value` body for 17CY, AppSync `SendRemoteCommand` for 24MM).
2. Re-read cached status up to six times at 10 second intervals. OneApp reads three times, but a 21MM bZ took 31 seconds to report a lock on 2026-11-16 and 40 seconds or more on 2026-11-17, and an unconfirmed lock abandons Remote Start. A transient 500 or 503 on one read moves on to the next read; a 429 or sign-in failure stops reading.
   When Toyota refuses a command with an HTTP error, the reason in the body (`message`, `errors[].message`, `status.messages[]` and similar, as in RedLink's `serverDetail`) is added to the error and logged with tokens, long opaque strings and VINs removed (`src/redact.ts`). A generic body with no reason adds nothing. At debug level the plugin also logs the header names and redacted body of every non-GET request, so a refused command can be compared with RedLink's.
3. If the report matches, HomeKit settles. If not, or if reads are still failing, the target returns to the reported state and a warning is logged. The lock does not claim to be locked on the strength of an accepted request.

One command runs at a time. A repeat of the command already running (a second tap, or Siri retrying) is absorbed quietly; a different command is refused and its target returns to the reported state. A rejection carried in an HTTP 200 body (for example `VEHICLE_MOVING`) is surfaced using RedLink's success-code rules: Toyota's success codes are not a closed set, so an unknown code counts as failure only when no accompanying text says it succeeded.

## Subscriptions and capabilities

Remote lock, unlock and start require an active Toyota Remote Connect subscription. Status reads may work without one; that is unverified. At discovery the plugin logs the vehicle's generation, its enabled remote capability names and the subscription list Toyota returns (names and status only) so the answer for a given vehicle is visible in the Homebridge log.

## Secrets

- Credentials and the client key live only in Homebridge's `config.json`.
- The session (tokens) is in `<storage>/homebridge-toyota/session.json`, mode 0600, written atomically, by either the platform or the settings UI server. The OTP challenge file never contains a password. The settings UI reads credentials from `config.json` on the server and never sends them to the browser.
- Logs contain no tokens, passwords, keys or full VINs (last four digits only).
- Tests use synthetic payloads and mocked `fetch`. No test opens a network connection.

## Verification status

Verified: parsing and mapping against synthetic payloads modelled on RedLink's test fixtures, token refresh and OTP flows against mocked responses, the settings UI handlers (send code, verify, rejected and expired codes, no secrets in responses, session file mode) against mocked fetch, the client reloading a session file written by another process, and HomeKit service creation against the real HAP library. The UI server also answered requests over IPC in a smoke run.

The `startClimate` request shape (URL, header names and values, body bytes) is pinned in `test/command-request.test.ts` against RedLink's `ToyotaRequestFactory`. The live HTTP 400 from issue #3 turned out to be the wrong command for the car: on a 21MM bZ, `engine-start` works and `startClimate` is refused, so 21MM EVs use `engine-start` (0.3.1). The Remote Start preparation sequence is tested against a stateful fake vehicle and mocked `fetch`, not a real one.

Verified live on 2026-11-14 with a 21MM bZ: sign-in with an emailed code through the settings page inside Homebridge UI, status polling, `door-lock`, `engine-start` and `engine-stop`.

Not verified: the platform's 30 second resume timer against a real Homebridge, the OTP challenge persistence across a restart, ForgeRock challenge lifetime, command confirmation timing, 24MM GraphQL commands, the window, moonroof and hatch preparation commands, and behaviour on other vehicles.
