# OctoPrint

Connects to an OctoPrint server (OctoPi or any install): status, temperatures, uploads, start, pause, resume, cancel, G-code lines and webcam snapshots.

## For users

### On OctoPrint

1. Check that OctoPrint is connected to the printer. The Connection panel shows the printer as operational.
2. Create a key: open Settings, then Application Keys, and create one named SlicerX. Copy it. (Settings, then API, holds the global key if you prefer it.)
3. Note the server's address. OctoPi answers on port 80. A manual install answers on port 5000.

### In SlicerX

1. Add a printer and choose Scan. OctoPrint announces itself with multicast DNS when its zeroconf plugin is on, which it is by default.
2. If it does not appear, choose OctoPrint and enter the address and the port if it is not 5000.
3. Enter the API key. SlicerX stores it in your keychain.

### Network and firewall

TCP 80 or 5000 (whichever your install uses). Webcam snapshots come from the snapshot URL in OctoPrint's webcam settings, which must be on the same host.

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "rejected the credentials" | The API key is wrong or was revoked. |
| Printer shows offline while the server answers | OctoPrint is up but not connected to the printer. Connect it in OctoPrint. |
| "is unreachable" | Wrong address or port. OctoPi uses 80, manual installs 5000. |
| No camera | Set a snapshot URL under Settings, Webcam and Timelapse. |
| Start fails with a state message | The printer is already printing or OctoPrint is not operational. |
| No layer numbers | OctoPrint does not report them without a plugin. |

### Untested on hardware

Checked against a simulator, not a server. First things to check: API key scopes on recent OctoPrint versions, the 409 answer when the printer is not connected, and webcam snapshot URLs behind a reverse proxy.

## For integrators

Plugin id `octoprint`. Capabilities: status, events, upload, start, pause, resume, cancel, camera, G-code console. No filament slots.

Printer config: `host`, optional `port` (default 5000), `credentialRef` for the API key (`X-Api-Key`), `tls`, `pollMs`.

### Requests

`GET /api/version` on connect (needs a valid key). Per poll: `GET /api/printer` and `GET /api/job`. A 409 from `/api/printer` means the serial connection is closed and maps to offline. Upload is a multipart `POST /api/files/local`. Start is `POST /api/files/local/{name}` with `{"command":"select","print":true}`. Pause, resume and cancel are `POST /api/job` with `pause` (`action` `pause` or `resume`) and `cancel`. G-code is `POST /api/printer/command`. The snapshot URL comes from `GET /api/settings`.

Mapping: the `printing` and `cancelling` flags map to printing, `paused` to paused, `error` to error, and a named file at 100 percent completion to finished.

### Events and rate

Polled every `pollMs` (default 1000), two requests per poll. The SockJS push channel is not used.

### Testing

`octoprint_contract` in `tests/drivers.rs`. `--auth` requires the mock API key.

### Sources

OctoPrint REST API: https://docs.octoprint.org/en/master/api/.
