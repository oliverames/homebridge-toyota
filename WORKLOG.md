# Worklog

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
