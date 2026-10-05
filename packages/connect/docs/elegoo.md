# Elegoo Centauri Carbon (SDCP)

Connects to the Elegoo Centauri Carbon over its network protocol, SDCP: status, temperatures, uploads, start, pause, resume, cancel and camera snapshots. Elegoo printers that run Klipper (Neptune 4) work through the Moonraker connector instead.

## For users

### On the printer

1. On the touchscreen, open Settings, then Network, and connect the printer to your network.
2. Note the IP address shown with the connected network. Your router's device list shows it as well.
3. If your firmware has a network control setting, turn it on. No account, access code or key is needed.

### In SlicerX

1. Add a printer and choose Scan. SlicerX sends one broadcast on your network and the printer answers. The scan runs only when you start it.
2. If it does not appear, choose Elegoo and enter the IP address. The port is 3030.

Neptune 4 printers run Klipper and use the Moonraker guide.

### Print options

Start passes bed leveling (`Calibration_switch`, default on) and timelapse (`Tlp_Switch`, default off).

### Network and firewall

| Port | Protocol | Used for |
| --- | --- | --- |
| 3030 | TCP | status and commands (WebSocket), file upload (HTTP) |
| 3031 | TCP | camera stream |
| 3000 | UDP | scanning |

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "is unreachable" or a timeout on connect | Wrong IP, printer off, or the printer is already serving other apps. Close the slicer, phone app or other tools that use it. |
| Upload fails | The printer is printing, storage is full, or port 3030 is blocked. |
| A finished print shows as idle | The printer's completed status has no documented code, so it reads as idle. |
| A command is refused | The printer is in a state that does not allow it, for example pausing while idle. |
| No G-code console | SDCP does not have one. |

### Untested on hardware

Written from the public protocol and a community write-up, and checked against a simulator, not a printer. Check first: the upload form fields, the status codes and the unit of the time counters (read as seconds).

## For integrators

Plugin id `elegoo`. Capabilities: status, events, upload, start, pause, resume, cancel, camera. No G-code console.

Printer config: `host`, optional `port` (3030).

### Protocol

WebSocket at `ws://host:3030/websocket`, JSON envelopes `{Id, Data:{Cmd, Data, RequestID, MainboardID, TimeStamp, From}, Topic}`. The mainboard id comes from the first status message. Commands: `0` refreshes status, `128` starts (`Filename` `/local/name.gcode`), `129` pauses, `130` stops, `131` resumes, `386` enables the MJPEG stream and returns its URL, which must be on the printer's host. Replies carry `Ack` (0 ok, 2 file not found). A `ping` goes out every 20 seconds because the printer closes idle sockets after 60. The connection reconnects every two seconds after a drop and the printer reads as offline meanwhile.

Upload is `POST /uploadFile/upload`, one megabyte per request, form fields `Check`, `S-File-MD5`, `Offset`, `Uuid`, `TotalSize`, `File`.

Status mapping: `PrintInfo.Status` 13 and 20 printing, 5 and 10 paused, 8 and 9 preparing, otherwise idle.

Scanning broadcasts `M99999` to UDP 3000 and parses the JSON replies. An IP address typed in setup gets the same `M99999` sent to it alone, so the printer is confirmed, with its name, model and firmware, before the WebSocket is tried.

### Events and rate

Pushed by the printer. Status events fire when anything other than the timestamp changes.

### Testing

`elegoo_sdcp_contract` in `tests/drivers.rs`, against a fake with hand written WebSocket framing.

### Sources

SDCP V3.0.0: https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0. Centauri Carbon notes: https://github.com/WalkerFrederick/sdcp-centauri-carbon.
