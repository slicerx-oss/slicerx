# PrusaLink

Connects to Prusa printers that run PrusaLink: MK4S, MK4, MK3.9, MINI+, XL and Core One. The MK3.5 and Core One L are not in the printer list yet. It needs firmware 4.7.0 or later, and 5.1.0 or later on the MINI. Status, temperatures, uploads to a USB drive, start, pause, resume, cancel and camera snapshots. Prusa Connect (the cloud service) is not used.

## For users

### On the printer

1. On the printer screen, open Settings, then Network. Connect Wi-Fi or Ethernet if it is not connected. The connection status shows the IP address.
2. In Settings > Network > PrusaLink, turn PrusaLink on. It shows the password. The user name is always `maker`.
3. Keep a USB drive in the printer. Uploads are stored on it.

### In SlicerX

1. Add a printer and choose PrusaLink, then enter the IP address. SlicerX asks that address for its PrusaLink version (`GET /api/version`) to confirm the printer before you sign in. Prusa printers are not known to announce themselves on the network, so a scan may not find them.
2. Enter the password. Leave the user name empty unless you changed it; SlicerX uses `maker`. Older firmware that shows an API key instead takes it in the same field. SlicerX stores it in your keychain. The port is 80.

### Network and firewall

TCP 80 (or 443 if you enabled https and set the printer to use it).

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "rejected the credentials" | Wrong password or API key. Read it again in Settings > Network > PrusaLink. The 5.1 firmware update reset the old logins. |
| "is unreachable" | Wrong IP, printer off, or a different network. |
| "a USB drive ... not found" | The printer lists no writable storage. Insert a USB drive. |
| "is busy: the file is printing ..." | You sent a file with the name of the one printing, or the drive is busy. Wait for the print or rename the file. |
| "is busy: a print is running ..." | A print is already running. |
| Status says paused with "Printer needs attention" | The printer is waiting for you, for example a filament change. Resume from the printer. |
| No layer numbers | PrusaLink does not report them. Progress and time left are shown instead. |
| No G-code console | PrusaLink has no endpoint for it. |

## For integrators

Plugin id `prusalink`. Capabilities: status, events, upload, start, pause, resume, cancel, camera (when a camera is configured). No filament slots, no G-code console.

Printer config: `host`, optional `port`, `credentialRef` for the password, optional `username` (default `maker`), `tls`, `pollMs`. The spec declares HTTP Digest only (MD5, `qop=auth`). The first request draws a 401 challenge that is answered and reused for the session. A 401 without a Digest challenge, or a Digest answer refused before anything got in, is tried once with the secret as `X-Api-Key` (older PrusaLink takes a key); whichever gets in is kept for the session. A Digest challenge for another algorithm (SHA-256) cannot be answered and is written to the connection log (`SX_CONNECT_LOG`).

### Requests

`GET /api/v1/info` and `GET /api/version` on connect (serial, nozzle diameter, MMU, firmware), `GET /api/v1/status` and `GET /api/v1/job` per poll (the job endpoint answers 204 when idle). Each upload reads `GET /api/v1/storage` and uses the first available, writable storage, USB first, then `local`, then an SD card; with none it asks for a USB drive, and a printer without the endpoint gets `usb`. Upload is `PUT /api/v1/files/{storage}/{name}` with `Overwrite: ?1` and `Print-After-Upload: ?0`. Start is `POST /api/v1/files/{storage}/{name}`. A 409 on either says the printer is busy, in words for the action. Pause and resume are `PUT /api/v1/job/{id}/pause|resume` and cancel is `DELETE /api/v1/job/{id}`, using the job id from the status. Camera frames come from `/api/v1/cameras/{id}/snap`.

State mapping: `PRINTING` to printing, `PAUSED` to paused, `ATTENTION` to paused with a message, `BUSY` to preparing, `FINISHED`, `ERROR`, `STOPPED` to idle with "The print was stopped", `IDLE` and `READY` to idle.

The spec has no model field. The model is read only when `/api/version` names one in `original` or `text` (unconfirmed on hardware). An MMU3 is listed with five slots when `mmu` is true; an XL's toolheads are not reported, so they come from the catalog model.

### Events and rate

Polled every `pollMs` (default 1000), two requests per poll. On a MINI+ or a printer on Wi-Fi, use 2000 or more.

### Testing

`prusalink_contract`, `prusalink_digest_login_passes_the_contract` and `prusalink_key_fallback_storage_and_busy` in `tests/drivers.rs`, against a fake backed by the Bay 3 MK4S fixture. `--auth` requires the mock API key; `--digest` requires digest login (user `maker`, password `mock-digest-pass`), checked by an independent implementation.

### Sources

PrusaLink API specification: https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml.

### Untested on hardware

Checked against a simulator, not a printer. First things to check: digest login on your firmware (the algorithm must be MD5), whether `X-Api-Key` still works on 5.x, the storage names `/api/v1/storage` lists, the `ATTENTION` state during a filament change, and whether `/api/version` names the model.
