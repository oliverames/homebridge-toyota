# Changelog

## 0.3.6 - 2026-11-27

- Stale reports are refreshed. Toyota serves the car's last upload, and on 2026-11-27 the plugin started on a report 3 hours 14 minutes old. Once the report is `staleReportHours` old (default and minimum 3, `0` turns it off) and no request went out within that time, the plugin asks the car for a fresh report (`refresh-status`, as RedLink does since 2026-11-15) and watches for it for about two minutes. Each request wakes the car, so the last request time is saved per vehicle and survives restarts; a parked car gets at most about eight a day. A wake sent by RedLink or the Toyota app shows up as a fresh report, so none is added on top. Not available on 24MM vehicles.
- The report time is now read as a timestamp too (`occurrenceDate`, then `lastTimestamp`, ISO or epoch), never from the envelope's server `timestamp`.

## 0.3.5 - 2026-11-27

- Each change in the reported door lock state is logged at info level with the time the vehicle uploaded that report (Toyota's `occurrenceDate`). When the lock state is unknown, the line names each door and whether it carried a lock value. Toyota serves the car's last upload, which can be hours old, so this shows whether a HomeKit lock tile that looks wrong came from a stale report or from parsing.

## 0.3.4 - 2026-11-17

- The EV battery read is parked for 12 hours only after three 403s in a row (a 400 or 404 still parks it at once). One 403 during a Toyota outage used to hide the battery for 12 hours.

## 0.3.3 - 2026-11-17

Fixes for the failures logged on 2026-11-16 and 2026-11-17, when Toyota answered 500, 503, 403 and 429 in bursts.

- A 401 or 403 forces a token refresh at most once every 5 minutes. Each forced refresh is a request to Toyota's sign-in server, and back-to-back refreshes during a gateway outage were what drew its HTTP 429s.
- The "client key has most likely been rotated" warning now needs three refreshed-and-still-refused requests in a row. It fired twice from a single passing 403, and the same key worked ten minutes later both times. The settings page still reports it on the first refusal.
- Commands are confirmed over six status reads (one minute) instead of three. A 21MM bZ took 31 seconds to report a lock, so Remote Start abandoned itself after Toyota had accepted the lock.
- A single 500 or 503 while confirming no longer abandons the command; the next read is tried. The status read that starts Remote Start preparation gets one retry after 5 seconds. A 429 or sign-in failure still stops at once.
- A repeat of the command already running (a second tap, or Siri retrying) is absorbed quietly instead of being logged as a failure and resetting the switch.

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
