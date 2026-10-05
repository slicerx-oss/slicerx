# Snapmaker

Connects to the Snapmaker U1 and to Snapmaker 2.0 machines (A150, A250, A350) in their 3D printing configuration: status, temperatures, uploads, start, pause, resume, cancel and G-code lines. J1 and Artisan are not supported yet.

## For users

### Snapmaker U1

1. On the touchscreen, open Settings, then Network, and connect the U1 to your network. The IP address is shown with the connected network.
2. In SlicerX, add a printer, choose Snapmaker, and enter the IP address.
3. No key is needed on the stock firmware. Enter one only if you turned on forced logins in a custom firmware.

The U1 runs Klipper with Moonraker, so all four toolheads are read. See the Moonraker guide for the port (80) and firewall details.

### Snapmaker 2.0 (A150, A250, A350)

1. On the touchscreen, open Settings, then the Wi-Fi or Network page, and connect the machine. Note the IP address shown there.
2. In SlicerX, add a printer, choose Snapmaker, and enter the IP address. Choose Pair.
3. Look at the machine's touchscreen: it asks whether to allow the connection. Tap to confirm within a minute. SlicerX stores the token the machine gives it in your keychain, so you do this once per machine (or again after the machine forgets the pairing).

What works: the 3D printing head, single or dual extruder. Laser and CNC heads are refused. Status shows temperatures, job name, progress and time left, and warnings when the enclosure door is open or filament has run out.

Sending a file loads it on the machine's screen. Only the file you sent last can be started, so send the file, then start it. Sending another file replaces the first.

### Network and firewall

TCP 8080 for the 2.0 machines, TCP 80 for the U1.

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "rejected the credentials" when connecting | The machine is not paired yet, or you did not tap to confirm in time. Run Pair again and confirm on the touchscreen. |
| Pairing times out | The prompt appeared and closed, or the machine is on another network. Run Pair again and watch the screen. |
| "laser and CNC tool heads is not supported" | The machine has a laser or CNC module attached. Attach the 3D printing head. |
| Start says the prepared file was not found | You sent a different file after this one. Send it again, then start. |
| J1 or Artisan does not connect | These machines use a different protocol (SACP over TCP 8888), which is not supported yet. |
| "is unreachable" | Wrong IP, machine off, or Wi-Fi disabled on the touchscreen. |

### Untested on hardware

The 2.0 driver was built from Snapmaker Luban's public source and community notes, and tested against a simulator. Things to check first on a real machine: that pairing completes, that newer A-series firmware accepts the token in the status request, that starting a print works remotely without a press on the touchscreen, and the field names for dual extruder temperatures. The U1 path is the Moonraker driver, checked against a simulator only.

## For integrators

Plugin id `snapmaker`. Capabilities: status, events, upload, start, pause, resume, cancel, camera (U1 only when a webcam exists), G-code console. Network: `lan:80`, `lan:8080`, `lan:7125`.

Printer config: `host`, optional `port`, `credentialRef` (keychain entry that holds the pairing token, or the Moonraker API key), `protocol` (`moonraker` or `luban`; probed when unset: Moonraker on the configured port or 80, otherwise Luban on 8080), `pollMs` (default 2000 for 2.0 machines).

### Pairing

`PrinterConnector::authorize(cfg, timeout)` posts `/api/v1/connect`, then polls `GET /api/v1/status?token=` until it stops answering 204, and returns the token. The caller stores it under `credentialRef`. Through `sx-link` the call is `printers.authorize`, which stores the token itself and never returns it. `connect` fails with `auth` when the token is missing, revoked or unconfirmed.

### Luban protocol

`POST /api/v1/prepare_print` (multipart `token`, `type=3DP`, `file`) uploads and loads a file; `POST /api/v1/start_print`, `pause_print`, `resume_print`, `stop_print` take the form field `token`; `POST /api/v1/execute_code` takes `token` and `code`. Status fields: `status`, `nozzleTemperature`, `nozzleTargetTemperature`, `heatedBedTemperature`, `heatedBedTargetTemperature`, `fileName`, `progress`, `remainingTime`, `isEnclosureDoorOpen`, `isFilamentOut`. `headType` 1 and 5 are printing heads.

### Events and rate

Polled every `pollMs` (default 2000). The screen firmware is slow; keep it at two seconds or more. A token that stops working shows as offline with an error event.

### Testing

`snapmaker_luban_pairs_and_passes_the_contract` and `snapmaker_starts_only_the_file_sent_last` in `tests/drivers.rs`, against a fake that confirms a new token after two status polls (`--only snapmaker-luban`). The link test `pairing_a_snapmaker_stores_the_token_without_returning_it` covers `printers.authorize`.

### Sources

Snapmaker Luban: https://github.com/Snapmaker/Luban (`SstpHttpChannel.ts`, `heartBeat.ts`). Newer A-series connection notes: https://github.com/James-Jennison/nozzle-it-all/pull/46. U1 Moonraker: https://github.com/Snapmaker/u1-moonraker.
