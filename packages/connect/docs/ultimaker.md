# UltiMaker

Connects to UltiMaker S3, S5, S6, S7, S8 and Factor 4 printers, and the UM3 family, over their local network API, the way UltiMaker Cura does: status, temperatures, print cores and materials, start, pause, resume, cancel and the camera. Digital Factory (the cloud service) is not used. Experimental: untested on a printer.

## For users

### On the printer

1. Connect the printer to your network by Ethernet or Wi-Fi, on the same network as this computer. A guest network or client isolation blocks it.
2. The printer needs firmware 4.0 or later.
3. No code or password is needed.

### In SlicerX

1. Add a printer and choose Scan. UltiMaker printers announce themselves, and the scan shows the model and firmware.
2. If it does not appear, choose UltiMaker and enter the IP address from your router's device list or the printer's network settings. SlicerX asks the printer for its name and model to confirm it.

Sending a file holds it in SlicerX: an UltiMaker prints a file as soon as it arrives, so the file goes to the printer only when you start it. When the print ends, clear the build plate and confirm on the printer, as usual.

### Network and firewall

TCP 80 for the API, TCP 8080 for the camera, UDP 5353 for scanning.

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "is unreachable" | Wrong IP, printer off, or another network. |
| "this firmware ... is not supported" | The printer has no cluster API. Update it to firmware 4.0 or later. |
| "Clear the build plate and confirm on the printer" | The print is done; the printer waits for the plate to be cleared before the next one. |
| Start says the file was not found | SlicerX holds only the file sent last. Send it again, then start. |
| No G-code console | The local API has none. |

## For integrators

Plugin id `ultimaker`, experimental (hidden unless experimental connectors are on). Capabilities: status, events, upload (held in the session), start, pause, resume, cancel, camera, filament slots. No G-code console.

Printer config: `host`, optional `port` (80), optional `credentialRef` holding `id:key` from pairing, optional `cameraPort` (8080), `pollMs` (default 2000).

### Discovery

`discover` asks multicast DNS for `_ultimaker._tcp.local` and reads the TXT records as Cura's `ZeroConfClient` does: only `type=printer` counts; `name`, `machine` (a BOM number such as `9051.0`, mapped to the model by the `bom_numbers` of Cura's machine definitions), `firmware_version` and `cluster_size` (above 1 marks a group host). `probe` asks a typed address for `GET /api/v1/system`, which needs no login: `name`, `variant` (the model), `firmware`, `guid`.

### Requests

`GET /api/v1/system` on connect; `GET /cluster-api/v1/printers` must answer (Cura's minimum, firmware 4.0). Status polls `GET /api/v1/printer` (status, hotend and bed temperatures, camera), `GET /api/v1/print_job` (404 when idle) and the cluster record of this printer (matched by GUID) for the print cores and materials per extruder. Start sends the held file to `POST /cluster-api/v1/print_jobs/` (multipart `owner` and `file`, plus `require_printer_name` with the printer's unique name so a group host prints it here). Pause, resume and cancel are `PUT /cluster-api/v1/print_jobs/{uuid}/action` with `{"action": "pause" | "print" | "abort"}`, as Cura sends them; a printer that wants a login for it gets `PUT /api/v1/print_job/state` with the bare JSON string and the Digest login. Camera: `http://host:8080/?action=snapshot` and `?action=stream`.

State mapping: printer `error` is an error, `booting` and `maintenance` idle with a message. Job `printing`, `resuming` and `post_print` print, `pausing` and `paused` pause, `pre_print` prepares, `wait_user_action` pauses with "Waiting for you on the printer's screen". `wait_cleanup` is finished, or idle with "The print was stopped" when `result` is `Aborted`, or an error when `Failed`, each asking to clear the build plate.

### Pairing

`authorize` posts `/api/v1/auth/request` (`application` and `user` are SlicerX), then polls `/api/v1/auth/check/{id}` every second until it answers `authorized` (returns `id:key`) or `unauthorized` (login need `declined`). Jobs need no pairing; with one, `connect` checks it with `GET /api/v1/auth/verify` (Digest, MD5).

### Testing

`ultimaker_holds_the_file_until_start_and_drives_the_job` in `tests/drivers.rs` against the fake in `mock-printers/src/ultimaker.ts` (`--only ultimaker`, camera on `ultimaker-camera`), and the unit tests in `src/drivers/ultimaker/mod.rs`.

### Sources

UltiMaker Cura network plugin (LGPL-3.0, read as a protocol reference only): `ZeroConfClient.py`, `LocalClusterOutputDeviceManager.py`, `ClusterApiClient.py`, `LocalClusterOutputDevice.py`, `ClusterPrinterStatus.py`, `ClusterPrintJobStatus.py` and the QML state names in https://github.com/Ultimaker/Cura/tree/main/plugins/UM3NetworkPrinting; machine `bom_numbers` in https://github.com/Ultimaker/Cura/tree/main/resources/definitions. Printer API description: https://gist.github.com/SimonIT/ea672554e9d642b517202125b10d3b37.

### Untested on hardware

Checked against a simulator only. Check first: whether current S series firmware (7.x and later) wants a login on the cluster API, the job state names during a real print, whether `require_printer_name` routes a job on a standalone printer, the camera port, and the touchscreen path for allowing a pairing.
