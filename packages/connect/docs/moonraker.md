# Moonraker (Klipper)

Connects to any printer running Klipper with Moonraker: Voron, RatRig, Sovol, Elegoo Neptune 4 and others. Creality and Snapmaker printers that run Klipper use this connector automatically; see their guides. Status, temperatures, uploads, start, pause, resume, cancel, G-code lines and webcam snapshots.

## For users

### On the printer

1. Check that Klipper and Moonraker are running. If Mainsail or Fluidd opens in a browser, they are.
2. Note the IP address: your router's device list shows it, or run `hostname -I` on the printer's computer.
3. If SlicerX later says it was rejected, Moonraker does not trust your computer yet. Either add your network to `trusted_clients` in the `[authorization]` section of `moonraker.conf` (for example `192.168.1.0/24`) and restart Moonraker, or read the API key by running `curl http://PRINTER_IP:7125/access/api_key` from a trusted machine.

### In SlicerX

1. Add a printer and choose Scan. Moonraker announces itself with multicast DNS, so most Klipper printers appear with their host name.
2. If yours does not, choose Moonraker and enter the IP address. The port is 7125 unless you changed it.
3. Enter the API key only if you use one.

Creality printers (K2 series, K1 with community firmware) and the Snapmaker U1 have their own entries in SlicerX with their own guides. They use the same Moonraker interface described here.

### Network and firewall

TCP 7125 (or the port you set). Webcam snapshots come from the address in Moonraker's webcam settings, which must be the printer's own address.

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "is unreachable" | Wrong IP or port, Moonraker not running, or the printer is off. |
| "does not trust this computer" | No API key was entered and your computer is not in `trusted_clients`. Enter the key, or add your network there and restart Moonraker. |
| "rejected the API key" | The key is wrong or was regenerated. Read it again. |
| "asks for a user login" | Logins are forced (`force_logins`, Fluidd or Mainsail accounts, Require Login on a Snapmaker U1). Enter the API key, which still works. SlicerX does not sign in with a user name and password yet. |
| Status shows an error, "Klipper is not ready" | Klipper stopped or is restarting. Use "Firmware restart" in Mainsail or Fluidd. |
| Start says busy or not allowed | A print is already running, or Klipper is in an error state. |
| No camera | Add a webcam with a snapshot URL in Mainsail or Fluidd. |
| Upload works but the file is missing in the slicer's queue | Files go into Moonraker's `gcodes` folder. |

## For integrators

Plugin id `moonraker`. Capabilities: status, events, upload, start, pause, resume, cancel, camera (when a webcam exists), G-code console. The `creality` and `snapmaker` connectors reuse this driver with their own ids and default ports (7125 and 80) when they find Moonraker. Wrap `MoonrakerConnector::for_plugin(id, default_port, gate)` to support another Klipper vendor.

Printer config: `host`, optional `port`, optional `credentialRef` for the API key (sent as `X-Api-Key`), `tls` for https, `pollMs`.

### Requests

`GET /server/info` on connect. Status is `GET /printer/objects/query` for `print_stats`, `virtual_sdcard`, `extruder` to `extruder5`, `heater_bed`, `temperature_sensor chamber` and `heater_generic chamber` (objects a printer lacks are omitted). Upload is a multipart `POST /server/files/upload` with `root=gcodes`. Start, pause, resume and cancel are `POST /printer/print/start|pause|resume|cancel`. G-code is `POST /printer/gcode/script`. A 503 on the query means Klipper is not ready and maps to `error`.

Mapping: `print_stats.state` `printing` and `paused` map directly, `complete` to `finished`, `error` to `error`, `standby` and `cancelled` to `idle`. Time left is estimated from print duration and progress.

### Events and rate

Polled every `pollMs` (default 1000), one query per poll plus none for the camera. Moonraker's WebSocket push (`notify_status_update`) is not used yet.

### Testing

The Moonraker mock backs `moonraker_contract`, `creality_contract_over_moonraker` and `snapmaker_contract_over_moonraker` in `tests/drivers.rs`. `--auth` makes it require the mock API key.

### Sources

Moonraker web API: https://moonraker.readthedocs.io/en/latest/web_api/.

### Untested on hardware

Checked against a simulator, not a printer. The WebSocket push channel is not used. Temperature objects a printer does not have are skipped.
