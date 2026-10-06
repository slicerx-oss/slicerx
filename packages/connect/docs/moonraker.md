# Moonraker (Klipper)

Connects to any printer running Klipper with Moonraker: Voron, RatRig, Sovol, QIDI, FLSUN, Elegoo Neptune 4 and others. Creality and Snapmaker printers that run Klipper use this connector automatically; see their guides. Status, temperatures, uploads, start, pause, resume, cancel, G-code lines, webcam snapshots, and the spools in a Happy Hare MMU or a QIDI Box.

## For users

### On the printer

1. Check that Klipper and Moonraker are running. If Mainsail or Fluidd opens in a browser, they are.
2. Note the IP address: your router's device list shows it, or run `hostname -I` on the printer's computer.
3. If SlicerX later says it was rejected, Moonraker does not trust your computer yet. Either add your network to `trusted_clients` in the `[authorization]` section of `moonraker.conf` (for example `192.168.1.0/24`), or read the API key by running `curl http://PRINTER_IP:7125/access/api_key` from a trusted machine. Moonraker reads `moonraker.conf` only when it starts, so restart Moonraker after any change there. The printer itself is not trusted automatically either: `localhost` and `127.0.0.1` need their own line.

### In SlicerX

1. Add a printer and choose Scan. Moonraker announces itself with multicast DNS, so most Klipper printers appear with their host name.
2. If yours does not, use Enter IP instead with the printer's IP address. SlicerX asks Moonraker's port 7125 and then port 80, where Mainsail and Fluidd pass the same API through. Leave the port empty unless you moved Moonraker.
3. Enter the API key only if you use one. A printer that forces logins also takes its user name and password.

Mainsail and Fluidd may sit on another port: 80 on most printers, 4408 and 4409 on Creality, 10088 for Fluidd on QIDI. That is the web page. If you type such a port and it answers with a web page, SlicerX switches to Moonraker's own 7125.

Creality printers (K2 series, K1 with community firmware) and the Snapmaker U1 have their own entries in SlicerX with their own guides. They use the same Moonraker interface described here.

### Network and firewall

TCP 7125 (or the port you set), and 7130 when Moonraker serves HTTPS. Webcams come from Moonraker's webcam list: a relative address is fetched from the web page's port (80, or the port you typed when it is a web page's), and an absolute one only when it is the printer's own address.

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "is unreachable" | Wrong IP or port, Moonraker not running, or the printer is off. |
| "does not trust this computer" | No API key was entered and your computer is not in `trusted_clients`. Enter the key, or add your network there and restart Moonraker. |
| "rejected the API key" | The key is wrong or was regenerated. Read it again. |
| "asks for a user login" | Logins are forced (`force_logins`, Fluidd or Mainsail accounts, Require Login on a Snapmaker U1). Enter the user name and password, or the API key, which still works. |
| "rejected the API key" after a user login | The user name or password is wrong. |
| Status shows "Klipper shutdown: ..." or "Klipper error: ..." | Klipper stopped with the reason shown, the same words Mainsail and Fluidd show. Fix the cause, then use "Firmware restart" there. |
| "Klipper is starting" | Klipper is still starting after power on or a restart. Wait a few seconds. |
| "answered, but not as Moonraker" | The port is a web page and Moonraker did not answer on 7125 either. Check the port Moonraker listens on (`[server] port` in `moonraker.conf`). |
| Start says busy or not allowed | A print is already running, or Klipper is in an error state. |
| No camera | Add a webcam with a snapshot URL in Mainsail or Fluidd. |
| Upload works but the file is missing in the slicer's queue | Files go into Moonraker's `gcodes` folder. |

## For integrators

Plugin id `moonraker`. Capabilities: status, events, upload, start, pause, resume, cancel, camera (when an enabled webcam exists), filament slots (Happy Hare MMU, QIDI Box, Snapmaker U1), G-code console. The `creality` and `snapmaker` connectors reuse this driver with their own ids and default ports (7125 and 80) when they find Moonraker. Wrap `MoonrakerConnector::for_plugin(id, default_port, gate)` to support another Klipper vendor.

Printer config: `host`, optional `port`, optional `credentialRef` (the API key, sent as `X-Api-Key`, or with `username` the user's password), `username` for a user login, `tls` for https, `pollMs`.

A user login is `POST /access/login`; the access token goes as `Authorization: Bearer` and is renewed with `POST /access/refresh_jwt` when a request answers 401 (tokens last an hour), and a new login follows when the refresh token is refused. Camera requests to Moonraker's own origin carry the same headers, so a camera behind Moonraker's login needs no one-shot token in its URL; `/access/oneshot_token` is for clients that cannot set headers, which SlicerX always can.

`probe` asks `GET /server/info` on 7125, then 80, without signing in (a 401 or 403 JSON error counts too), and reads the host name and object list when they are open. A Snapmaker U1 (`print_task_config`) and a Creality printer (`GET /info` on 80 names a model) are left to their own connectors.

### Requests

`GET /server/info` on connect, then `GET /printer/objects/list` once, and `/server/webcams/list` once per session. A configured port whose `/server/info` is not Moonraker's JSON is retried on 7125. Status is `GET /printer/objects/query` for `print_stats`, `virtual_sdcard`, `webhooks` (`state`, `state_message`), the extruders the object list names (`extruder` to `extruder5` when it is unknown; `extruder_stepper` is not a tool), `heater_bed`, `temperature_sensor chamber`, `heater_generic chamber`, `fan` and `gcode_move`, plus `mmu`, `save_variables` with `box_stepper slot0` to `slot15`, and `print_task_config` when the printer has them. Upload is a multipart `POST /server/files/upload` with `root=gcodes`, `checksum` (the SHA-256 Moonraker checks before it keeps the file) and `print=false`, allowed five minutes or longer for a large file. Start, pause, resume and cancel are `POST /printer/print/start|pause|resume|cancel`; the start is its own approved step, so the upload never starts a print by itself. G-code is `POST /printer/gcode/script`. A `webhooks` state of `shutdown`, `error` or `startup` maps to `error` with Klipper's message; a 503 on the query reads `/printer/info` for the same.

Hardware at setup: nozzle diameters, `kinematics`, `max_velocity`, `max_accel` and a delta's `print_radius` (else `delta_radius`) from `configfile.settings`; the build volume from `toolhead.axis_maximum` less `axis_minimum` (a negative minimum, a probe offset, counts as 0); the host name and Klipper version from `/printer/info`; `machine_name` from `/server/info` when a vendor build sets it (QIDI, as OrcaSlicer reads it), else U1 for a printer with `print_task_config`; and the filament units.

Filament units: a Happy Hare MMU's gates (`gate_material`, `gate_color`); a QIDI Box read as OrcaSlicer's QidiPrinterAgent reads it (`box_count`, `filament_slot<N>`, `color_slot<N>` from `save_variables`, a slot loaded when `box_stepper slot<N>` `runout_button` is 0, names and colors from `/server/files/config/officiall_filas_list.cfg`); the Snapmaker U1's four toolheads from `print_task_config` (`filament_exist`, `filament_type` with `filament_sub_type`, `filament_color_rgba`). Slot ids are 1, 2, ... for an MMU and the U1, A1 to A4 then B1 for QIDI Boxes. File info falls back to the file list where `/server/files/metadata` answers 404 (QIDI's Moonraker on the Q2 and X-Max 4).

Mapping: `print_stats.state` `printing` and `paused` map directly, `complete` to `finished`, `error` to `error`, `standby` and `cancelled` to `idle`. Time left is estimated from print duration and progress.

### Events and rate

Polled every `pollMs` (default 1000), one query per poll plus none for the camera. Moonraker's WebSocket push (`notify_status_update`) is not used yet.

### Testing

The Moonraker mock backs `moonraker_contract`, `creality_contract_over_moonraker` and `snapmaker_contract_over_moonraker` in `tests/drivers.rs`, and the probe, user login, QIDI Box, U1, Klipper state, checksum and webcam tests in `tests/plug_and_play.rs`. `--auth` makes it require the mock API key, `--force-logins` a login. `POST /moonraker` on the control server makes it a QIDI printer or a U1, sets Klipper's state, and ends the access tokens it issued.

### Sources

Moonraker web API and authorization: https://moonraker.readthedocs.io/en/latest/external_api/introduction/ (`docs/external_api` in the Moonraker repository). OrcaSlicer's MoonrakerPrinterAgent, QidiPrinterAgent and SnapmakerPrinterAgent for the QIDI Box, the U1 and `machine_name`.

### Untested on hardware

Checked against a simulator, not a printer. The WebSocket push channel is not used. Temperature objects a printer does not have are skipped. Webcam `flip_horizontal`, `flip_vertical` and `rotation` are read but not applied yet: the camera view has no orientation setting. The QIDI color dictionary's value format is taken as hex RRGGBB or RRGGBBAA, as OrcaSlicer's default suggests.
