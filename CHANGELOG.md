# Changelog

## 0.3.2 - 2026-11-14

- Public release under the MIT license, with a new README, an original icon, and a GitHub release tarball for installation.
- Design notes now record what was verified against a live 21MM bZ and no longer reference private repositories.

## 0.3.1

- Remote Start on 21MM EVs now uses `engine-start`/`engine-stop` on `v1/global/remote/command`, and confirms with engine status. Live test on 2026-11-14 (21MM bZ): `v2/electric/command` `startClimate` answered a bare HTTP 400 every time, while `engine-start` was accepted, engine status reported running within 20 seconds, and `engine-stop` stopped it. pytoyoda reports the same for the bZ4X. The EV climate route remains for 24MM EVs, where it is unverified.
- Toyota limits remote starts to about two per ignition cycle, so a failed or repeated attempt can use up the allowance until the car is driven.

## 0.3.0

- Remote Start now prepares the vehicle first (issue #3), on by default; set `remoteStart.prepare` to `false` to start immediately. It reads status and refuses, with a logged reason, if a door, the hood or the hatch is open. Otherwise it locks unlocked doors, closes open windows and the moonroof where the vehicle reports the capability (`power-window-close`, `sunroof-close`), and locks an unlocked hatch (`trunk-lock`). Each step is skipped when already satisfied, confirmed from status like a lock, and a refused or unconfirmed step abandons the start and returns the switch to off.
- The hatch or trunk lock token is now parsed for the trunk opening (door lock state still counts doors only).
- When Toyota refuses a command with an error body that carries a reason, the log and error message now show that reason, with tokens, long opaque strings and VINs removed. Debug logging shows the header names and redacted body of each non-GET request.
- `x-correlationId` is now an uppercase UUID, as RedLink sends it.
- The `startClimate` request is pinned by a unit test against RedLink's request factory. That comparison found no difference in URL, headers or body, so the HTTP 400 on EV climate start from the 2026-11-14 live test is not explained by the request shape. See the notes in issue #3.

## 0.2.0

- Added a Homebridge custom settings UI. **Sign in / Send code** starts the Toyota login with the saved email, password and client key, **Verify** completes it with the emailed code, and a status line shows the account, vehicle count and session age. No restart is needed (issue #2).
- Verifying writes the same `session.json` the platform already uses. The platform reloads it when the file changes, and a poller that paused for a sign-in problem resumes within 30 seconds of a new session.
- The settings page never returns passwords, tokens, keys or codes to the browser.
- The `oneTimePasscode` config field remains as a fallback.
- Added `@homebridge/plugin-ui-utils` as a dependency.

## 0.1.0

- First release: native HomeKit lock, contact sensors, EV battery and optional Remote Start for Toyota North America vehicles.
