# Worklog

## 2026-11-27 - 0.4.0: HomeKit metadata, availability, sign-in hardening

**What changed**: Oliver asked for a security pass, better Home app and Siri metadata, login robustness and reliability. Two read-only Sonnet reviews (security audit; HomeKit metadata against hap-nodejs definitions) found no high-severity issue and `npm audit` clean. 0.4.0 names every service after the vehicle with `ConfiguredName` (written only while empty), makes Doors primary, sets firmware to the plugin version, flags stale contact sensors with `StatusFault`, answers No Response while sign-in is fatal and on cached accessories before the first vehicle list, adds 30 s sign-in timeouts, a 60 s Send-code cooldown, VIN validation, per-process temp files and non-quoting JSON errors. Declined from the reviews: off-host redirect blocking (no evidence Toyota redirects; the authorize step needs manual redirects), shortening the VIN in SerialNumber, ServiceLabelIndex, LockManagement and Battery linking.

**Verified**: 186 tests, lint, typecheck and build pass locally. Released as v0.4.0. Not verified on a device: how the Home app shows `StatusFault` on a contact sensor, and whether setting `ConfiguredName` replaces any rename Oliver made earlier only inside the Home app (services had no `ConfiguredName` before, so iOS kept such names locally).

**Left off at**: Nothing deployed since 0.3.7; SSH has failed since the 0.3.9 attempt because the 1Password agent stopped signing. Pending on home-server: install 0.4.0 (includes 0.3.8/0.3.9 auto-lock), add `autoLock: {enabled: true, afterMinutes: 10}` (approved), restart only the Toyota bridge. Login root cause not yet found: needs `grep` of the Homebridge log for "Saved Toyota sign-in was rejected" and "Polling is paused" to see how often and why the refresh token dies.

---

## 2026-11-27 - 0.3.8 and 0.3.9: auto-lock

**What changed**: Oliver asked for better power, lock and temperature state and for auto-lock. Temperature is not possible: RedLink's inventory (`docs/trends-data-inventory-2026-09-06.md`) found no endpoint returning cabin, outside or battery temperature, only the climate target. No HomeKit type exists for ignition or plug state. 0.3.8 adds opt-in auto-lock ported from RedLink's `ToyotaAutoLock` (fresh zero-speed telemetry, all closed, engine and climate off, 15 min grace after a HomeKit unlock, 10 min cooldown, 3 attempts per episode) plus a 10 minute unlocked dwell and a cap of 3 fresh-report requests per episode. A background security review found two real defects in 0.3.8 (an unknown engine state counted as not running; a HomeKit unlock during the telemetry read did not stop the attempt), fixed in 0.3.9.

**Verified**: 178 tests, lint, typecheck and build pass locally. Released as v0.3.8 and v0.3.9.

**Left off at**: Oliver approved deploying 0.3.9 with `autoLock: {enabled: true, afterMinutes: 10}`, but SSH failed at the first step when the 1Password agent stopped signing. home-server is unchanged: 0.3.7, auto-lock off, config untouched. When SSH works: back up config.json, install the 0.3.9 tarball, add `autoLock` to the Toyota platform, restart only the Toyota bridge, and watch for the first "Auto-lock" line. The car last reported its doors and hatch unlocked (21:59:29Z).

---

## 2026-11-27 - 0.3.7: Home app wakes, fast follow-up, hatch lock, stale display

**What changed**: Oliver asked for more frequent updates and better state, and chose all four options. 0.3.7 wakes the car when the Home app reads the Doors lock and the report is 15+ minutes old (capped at eight a day), polls every minute for 10 minutes after any command, wake or running engine, adds a Hatch lock once the car reports a hatch lock value (`trunk-lock`/`trunk-unlock`), shows locks as Unknown when the report is over 12 hours old, and logs every opening once per start.

**Verified**: 161 tests, lint, typecheck and build pass locally. Released as v0.3.7. AppSync push research is in the session scratchpad: RedLink's 21MM subscription got acks but no event (redlink-lite docs/refresh-behavior-review-2026-09-08.md), and the corrected probe `Scripts/toyota-feed-observe.py` has never run on a device.

**Left off at**: v0.3.7 deployed to home-server at 17:08 with Oliver's go-ahead (0.3.6 backed up). Verified live: the bZ reports Door, Rear Door, Window, Hatch and Hood, with lock values for both door groups and the hatch, so the Hatch lock was created; all reported unlocked at 21:59:29Z. Not yet exercised: a Home-app wake, minute polling after a command, and a Hatch lock or unlock. Next for push: an observe-only AppSync probe inside the plugin process, behind a flag, off by default.

---

## 2026-11-27 - 0.3.6: refresh stale reports

**What changed**: 0.3.5 went live on home-server at 15:09 and its first line showed Toyota serving a report 3 hours 14 minutes old (16:54:58Z, unlocked). RedLink has woken the car for stale reports since 2026-11-15 at Oliver's request, so 0.3.6 ports `wakesForStaleReport`: `refresh-status` when the report is `staleReportHours` old (default and minimum 3, 0 off) and no wake in that time, the wake time saved per VIN, then about two minutes of reads for the newer report.

**Verified**: 153 tests, lint, typecheck and build pass locally; the refresh request is pinned against RedLink's `ToyotaRequestFactory`. Released as v0.3.6. 0.3.5 is running on home-server (0.3.4 backup in `~/.homebridge/backups/`).

**Left off at**: v0.3.6 deployed to home-server at 16:59 with Oliver's go-ahead (0.3.5 backed up). Verified live: the first poll found a 5.1 hour old report, `refresh-status` was accepted, and the bZ's fresh report (21:59:29Z) arrived within 21 seconds; it still reported the doors unlocked. Next options (Home-app wake, faster polling after activity, hatch lock, engine timer, AppSync push) are with Oliver.

---

## 2026-11-27 - 0.3.5: lock state visibility

**What changed**: Reviewed the home-server log from 11/14 to 11/27 after reports of an inconsistent lock state. Since 0.3.3, every Remote Start and its preparatory lock confirmed (11/19, 11/25, 11/26); the only unconfirmed lock command was the 11/16 unlock under the old 30 s window. The info log never recorded what each poll reported, so the lock tile could not be traced. 0.3.5 logs each change in the reported lock state with Toyota's `occurrenceDate`, and the per-door lock values when the state is unknown.

**Verified**: 143 tests, lint, typecheck and build pass locally. Released as v0.3.5 on GitHub.

**Decisions made**: Unknown is still shown when a door lacks a lock value, and the tile still starts Unknown after a restart. Both are pinned by tests as deliberate, and the log gives no evidence of lock-less reports yet.

**Left off at**: v0.3.5 is installed on home-server (0.3.4 backed up to `~/.homebridge/backups/homebridge-toyota-0.3.4-2026-11-27`), but the Toyota child bridge has not been restarted, so 0.3.4 code is still running. SSH dropped when the 1Password agent stopped signing. After deploying, compare the "Doors reported" lines against what the car actually showed. A stale `occurrenceDate` points at Toyota's cache (an opt-in status refresh would be the fix); a missing lock value points at parsing.

---

## 2026-11-17 - 0.3.3: outage hardening

**What changed**: Diagnosed failures from the home-server log (Toyota 500/503/403 bursts, sign-in 429s, a false "client key rotated" warning twice, and a Remote Start abandoned because the lock was not reported within 30 s). 0.3.3 throttles forced refreshes to one per 5 minutes, needs three refreshed-and-refused requests before blaming the key, confirms over six reads, tolerates a transient read failure, and absorbs repeated taps.

**Verified**: 140 tests, lint, typecheck and build pass locally. Deployed to home-server (0.3.1 backed up to `~/.homebridge/backups/homebridge-toyota-0.3.1-2026-11-17`); the child bridge restarted on v0.3.3 and vehicle discovery succeeded.

**Left off at**: 0.3.4 (EV battery parks only after three 403s in a row) is released as v0.3.4 on GitHub and running on home-server. Not yet exercised: the longer confirmation window and the throttle against a real Toyota outage. Watch the next Remote Start in the log. Tracked in #6 (also carries the passcode-across-restart check). #1 closed: CI green, live since 2026-11-14 with no child-bridge crashes.

---

## 2026-11-14 - Built, live-tested and published

**What changed**: Built the plugin from 0.1.0 to 0.3.2 in one day. Added a settings-page sign-in for Toyota's emailed code (0.2.0, #2), Remote Start preparation that locks, closes and checks the vehicle first and logs Toyota's refusal reason (0.3.0, #3), and switched 21MM EVs to `engine-start`/`engine-stop` after `startClimate` returned HTTP 400 on a live 21MM bZ (0.3.1). 0.3.2 made the repository public under MIT with a new README, an icon, and a release tarball for installation.

**Verified**: 132 tests, lint, typecheck and build pass locally; CI passes on Node 22 and 24 at 375575d. Live on a 21MM bZ: sign-in with an emailed code, status polling, `door-lock`, `engine-start`, `engine-stop`. Git history and issues were scanned for credentials, VINs and personal details before going public.

**Decisions made**: HomeKit-native services only; Remote Start is the single opt-in switch. No climate or temperature settings and no HomeKit thermostat: the car uses the climate saved in the Toyota app (#4 closed, not planned). Not published to npm; installs come from GitHub release tarballs.

**Left off at**: Running 0.3.1 in production (0.3.2 changed only docs and license).

**Open questions**: Still open in #1: window, moonroof and hatch preparation commands and 24MM vehicles are untested on a real car, and the HomeKit switch itself has not been exercised end to end.

---
