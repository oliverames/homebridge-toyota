# Changelog

## 0.2.0

- Added a Homebridge custom settings UI. **Sign in / Send code** starts the Toyota login with the saved email, password and client key, **Verify** completes it with the emailed code, and a status line shows the account, vehicle count and session age. No restart is needed (issue #2).
- Verifying writes the same `session.json` the platform already uses. The platform reloads it when the file changes, and a poller that paused for a sign-in problem resumes within 30 seconds of a new session.
- The settings page never returns passwords, tokens, keys or codes to the browser.
- The `oneTimePasscode` config field remains as a fallback.
- Added `@homebridge/plugin-ui-utils` as a dependency.

## 0.1.0

- First release: native HomeKit lock, contact sensors, EV battery and optional Remote Start for Toyota North America vehicles.
