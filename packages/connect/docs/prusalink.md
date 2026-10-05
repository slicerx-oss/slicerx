# PrusaLink

Connects to Prusa printers that run PrusaLink: MK4S, MK4, MK3.9, MINI+, XL and Core One. Status, temperatures, uploads to a USB drive, start, pause, resume, cancel and camera snapshots. Prusa Connect (the cloud service) is not used.

## For users

### On the printer

1. On the printer screen, open Settings, then Network. Connect Wi-Fi or Ethernet if it is not connected. The connection status shows the IP address.
2. In Settings, Network, open PrusaLink and turn it on. It shows the user name (`maker`) and the password, or the API key. Menu names depend on the firmware version.
3. Keep a USB drive in the printer. Uploads are stored on it.

### In SlicerX

1. Add a printer and choose PrusaLink, then enter the IP address. SlicerX asks that address for its PrusaLink version (`GET /api/version`) to confirm the printer before you sign in. Prusa printers are not known to announce themselves on the network, so a scan may not find them.
2. Enter the API key, or the user name and the password if the printer shows those. SlicerX stores them in your keychain. The port is 80.

### Network and firewall

TCP 80 (or 443 if you enabled https and set the printer to use it).

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "rejected the credentials" | Wrong API key, or wrong user name or password. Both login styles are supported; use the one the printer shows in its network settings. |
| "is unreachable" | Wrong IP, printer off, or a different network. |
| Upload fails | No USB drive, drive full, or the printer is busy printing from it. |
| Status says paused with "Printer needs attention" | The printer is waiting for you, for example a filament change. Resume from the printer. |
| No layer numbers | PrusaLink does not report them. Progress and time left are shown instead. |
| No G-code console | PrusaLink has no endpoint for it. |

## For integrators

Plugin id `prusalink`. Capabilities: status, events, upload, start, pause, resume, cancel, camera (when a camera is configured). No filament slots, no G-code console.

Printer config: `host`, optional `port`, `credentialRef` for the API key (sent as `X-Api-Key`), or `username` plus `credentialRef` for the password (HTTP digest, MD5, `qop=auth`), `tls`, `pollMs`. With digest login the first request draws a 401 challenge that is answered once and reused for the session.

### Requests

`GET /api/v1/info` on connect, `GET /api/v1/status` and `GET /api/v1/job` per poll (the job endpoint answers 204 when idle). Upload is `PUT /api/v1/files/usb/{name}` with `Overwrite: ?1` and `Print-After-Upload: ?0`. Start is `POST /api/v1/files/usb/{name}`. Pause and resume are `PUT /api/v1/job/{id}/pause|resume` and cancel is `DELETE /api/v1/job/{id}`, using the job id from the status. Camera frames come from `/api/v1/cameras/{id}/snap`.

State mapping: `PRINTING` to printing, `PAUSED` to paused, `ATTENTION` to paused with a message, `BUSY` to preparing, `FINISHED`, `ERROR`, otherwise idle.

### Events and rate

Polled every `pollMs` (default 1000), two requests per poll. On a MINI+ or a printer on Wi-Fi, use 2000 or more.

### Testing

`prusalink_contract` and `prusalink_digest_login_passes_the_contract` in `tests/drivers.rs`, against a fake backed by the Bay 3 MK4S fixture. `--auth` requires the mock API key; `--digest` requires digest login (user `maker`, password `mock-digest-pass`), checked by an independent implementation.

### Sources

PrusaLink API specification: https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml.

### Untested on hardware

Checked against a simulator, not a printer. First things to check: digest login on your firmware (the algorithm must be MD5), uploads to the `usb` storage, and the `ATTENTION` state during a filament change.
