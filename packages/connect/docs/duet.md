# Duet (RepRapFirmware)

Connects to Duet 2 and Duet 3 boards running RepRapFirmware 3, standalone or with a single board computer running DuetWebServer. Status, temperatures, uploads, start, pause, resume, cancel and G-code lines.

## For users

### On the board

1. Open Duet Web Control in a browser to confirm the board is on your network.
2. In its G-code console, send `M552`. The reply shows the IP address. The board's `.local` name works as well.
3. If you set a password with `M551`, have it ready. Boards without one accept the default, `reprap`.

### In SlicerX

1. Add a printer and choose Duet. Duet boards are not found by scanning, so enter the address.
2. Enter the password if you set one. SlicerX stores it in your keychain. The port is 80.

### Network and firewall

TCP 80.

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "rejected the credentials" | Wrong password (`M551`). |
| "rr_connect error 2" | The board has no free sessions. Close other Duet Web Control tabs and apps and try again. |
| "is unreachable" | Wrong address, network module off (`M552 S1`), or the board is off. |
| Start does nothing | The board is busy or in a halted state; check Duet Web Control. |
| No camera | Duet boards do not serve cameras through this connector. |

### Untested on hardware

Checked against a simulator, not a board. First things to check: `rr_connect` on RepRapFirmware 3.4 and newer (session keys), the object model field names on your firmware, and that `M32` and `M0` behave as expected with your `cancel.g`.

## For integrators

Plugin id `duet`. Capabilities: status, events, upload, start, pause, resume, cancel, G-code console. No camera, no filament slots.

Printer config: `host`, optional `port` (80), `credentialRef` for the password, `pollMs`.

### Requests

`GET /rr_connect?password=...` on connect (`err` 0 ok, 1 wrong password, 2 no sessions). Per poll: `GET /rr_model?flags=d99vn`. Upload is `POST /rr_upload?name=0:/gcodes/{name}`. Commands go through `GET /rr_gcode?gcode=...`: `M32 "0:/gcodes/name"` starts, `M25` pauses, `M24` resumes, `M0` cancels.

Mapping: `processing`, `simulating` and `resuming` map to printing, `pausing` and `paused` to paused, `halted` to error, `off` to offline, otherwise idle. RepRapFirmware has no finished state, so the event stream reports a job finished when progress was at least 98 percent before it went idle.

### Events and rate

Polled every `pollMs` (default 1000). Each poll fetches the whole object model, which is a few kilobytes on a small machine and much more with many tools; raise `pollMs` on large machines. Sessions are not closed with `rr_disconnect` and expire on the board.

### Testing

`duet_contract` in `tests/drivers.rs`. `--auth` sets the mock password `mock-reprap`.

### Sources

RepRapFirmware HTTP requests: https://github.com/Duet3D/RepRapFirmware/wiki/HTTP-requests.
