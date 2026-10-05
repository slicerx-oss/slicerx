# Snapmaker

Plugin id `snapmaker`. Two protocols, picked by probing when the config does not set `protocol`:

1. Moonraker, for the Snapmaker U1 (Klipper with a modified Moonraker that nginx serves on port 80, LAN clients trusted by default). The driver is the Moonraker driver (`../moonraker/README.md`) with this plugin id.
2. The HTTP API Snapmaker Luban uses on the 2.0 machines (A150, A250, A350), in `luban.rs`, on port 8080.

`protocol: "moonraker"` or `protocol: "luban"` skips the probe. J1 and Artisan speak SACP over TCP 8888, which is not implemented.

## Luban API

- Pairing: `POST /api/v1/connect` (form field `token`, empty on first contact) answers `{token, series, headType, ...}`. The printer then answers `GET /api/v1/status?token=...` with 204 until the user confirms on the touchscreen. `authorize` runs this and returns the token, which the app keeps in the keychain under the printer's `credentialRef`. `connect` refuses a missing, revoked or unconfirmed token with `auth`.
- Tool heads: `headType` 1 (single extruder) and 5 (dual extruder) print. Laser and CNC heads (2, 3, 4, 6 to 9) are refused with `not_supported`.
- Status: `GET /api/v1/status?token=` returns `status` (`IDLE`, `RUNNING`, `PAUSED`), `nozzleTemperature`, `nozzleTargetTemperature` (with `1` and `2` suffixes on dual heads), `heatedBedTemperature`, `heatedBedTargetTemperature`, `fileName`, `progress` (fraction), `remainingTime` (seconds), `isEnclosureDoorOpen` and `isFilamentOut` (shown as the status message). Polled every two seconds by default.
- Upload: `POST /api/v1/prepare_print` (multipart `token`, `type=3DP`, `file`) sends the file and loads it on the printer's screen. Only the file sent last can be started, so `start` refuses any other with `not_found`.
- Control: `POST /api/v1/start_print`, `pause_print`, `resume_print`, `stop_print` (form field `token`). G-code: `POST /api/v1/execute_code` with `token` and `code`.
- No camera.

## Sources

- Snapmaker Luban, HTTP channel: https://github.com/Snapmaker/Luban (`src/server/services/machine/channels/SstpHttpChannel.ts`, `src/server/services/task-manager/workers/heartBeat.ts`)
- Notes on newer A-series connections (token only in request bodies, confirmation on the touchscreen): https://github.com/James-Jennison/nozzle-it-all/pull/46
- Snapmaker U1 Moonraker: https://github.com/Snapmaker/u1-moonraker

## Source licenses

Snapmaker Luban is an AGPL-3.0 project. It was read as a protocol reference only: endpoint paths, form field names, status fields and the pairing flow. The Rust driver and its tests were written for this crate from those facts and do not copy or translate Luban's code. The mock printer was written the same way.

## Untested on hardware

Written from Luban's source and the mock. Check first: whether newer A-series firmware accepts the token in the query string of `status` (Luban does that, some newer builds want it in the body), the exact `status` strings and whether `progress` is a fraction, whether `start_print` works remotely without a press on the touchscreen, and the dual extruder field names. Enclosure state is read only as the door flag; `GET /api/v1/enclosure` (light, fan) is not used.
