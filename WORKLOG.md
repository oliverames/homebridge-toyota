# Worklog

## 2026-11-14 - Built, live-tested and published

**What changed**: Built the plugin from 0.1.0 to 0.3.2 in one day. Added a settings-page sign-in for Toyota's emailed code (0.2.0, #2), Remote Start preparation that locks, closes and checks the vehicle first and logs Toyota's refusal reason (0.3.0, #3), and switched 21MM EVs to `engine-start`/`engine-stop` after `startClimate` returned HTTP 400 on a live 21MM bZ (0.3.1). 0.3.2 made the repository public under MIT with a new README, an icon, and a release tarball for installation.

**Verified**: 132 tests, lint, typecheck and build pass locally; CI passes on Node 22 and 24 at 375575d. Live on a 21MM bZ: sign-in with an emailed code, status polling, `door-lock`, `engine-start`, `engine-stop`. Git history and issues were scanned for credentials, VINs and personal details before going public.

**Decisions made**: HomeKit-native services only; Remote Start is the single opt-in switch. No climate or temperature settings and no HomeKit thermostat: the car uses the climate saved in the Toyota app (#4 closed, not planned). Not published to npm; installs come from GitHub release tarballs.

**Left off at**: Running 0.3.1 in production (0.3.2 changed only docs and license).

**Open questions**: Still open in #1: window, moonroof and hatch preparation commands and 24MM vehicles are untested on a real car, and the HomeKit switch itself has not been exercised end to end.

---
