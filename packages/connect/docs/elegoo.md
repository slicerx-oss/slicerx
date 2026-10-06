# Elegoo Centauri Carbon (SDCP)

Connects to the Elegoo Centauri Carbon over its network protocol, SDCP: status, temperatures, uploads, start, pause, resume, cancel and camera snapshots. Elegoo printers that run Klipper (Neptune 4) work through the Moonraker connector instead.

## For users

### On the printer

1. Connect the printer to your network in the touchscreen's network settings.
2. Note the IP address shown with the connected network. Your router's device list shows it as well.
3. No account, access code or key is needed. The printer serves only a few apps at once, so close ElegooSlicer and the Elegoo phone app before you connect.

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
| "is unreachable" or a timeout on connect | Wrong IP, printer off, or another network (guest Wi-Fi, a VLAN or client isolation). |
| "no SDCP status after connecting" | The printer is already serving its limit of apps. Close ElegooSlicer, the phone app or other tools that use it. |
| "the printer has ... MB free" | The printer's storage is full. Delete files on the printer. |
| "upload refused: ..." | The printer's own reason for a refused part of the file (bad offset, file could not be opened). Send it again. |
| "refused the print: ..." | The printer's reason: MD5 check failed, file could not be read, wrong format, or sliced for another model. |
| "is busy" | The printer is busy with another job or a file transfer. |
| A finished print shows as idle | Some firmware sets the completed code only briefly. SlicerX reads 9 as complete once the printer is idle. |
| No G-code console | SDCP does not have one. |

### Untested on hardware

Written from the public protocol and community write-ups, and checked against a simulator, not a printer. Check first: the upload form fields, the status codes, the unit of the time counters (read as seconds; the spec says milliseconds), the unit of `RemainingMemory` (read as bytes; the spec says bits), and how many apps the printer serves at once.

## For integrators

Plugin id `elegoo`. Capabilities: status, events, upload, start, pause, resume, cancel, camera, a file list and the hardware it reports. No G-code console.

Printer config: `host`, optional `port` (3030).

### Protocol

WebSocket at `ws://host:3030/websocket`, JSON envelopes `{Id, Data:{Cmd, Data, RequestID, MainboardID, TimeStamp, From}, Topic}`. The mainboard id comes from the first status message. Commands: `0` refreshes status, `1` asks for the attributes (model, firmware, mainboard id, build size, camera, free storage), `128` starts (`Filename` `/local/name.gcode`, `StartLayer` 0), `129` pauses, `130` stops, `131` resumes, `258` lists `/local/`, `386` enables the MJPEG stream and returns its URL, which must be on the printer's host. Replies carry `Ack`: 0 ok, 1 busy, 2 file not found, and for a start 3 MD5 failed, 4 file read failed, 5 resolution mismatch, 6 unknown format, 7 wrong model, each in words. `sdcp/error` messages (1 MD5 failed, 2 wrong format) become error events. A `ping` goes out every 20 seconds because the printer closes idle sockets after 60. The connection reconnects every two seconds after a drop and the printer reads as offline meanwhile.

Upload is `POST /uploadFile/upload`, one megabyte per request, form fields `Check`, `S-File-MD5`, `Offset`, `Uuid`, `TotalSize`, `File`. A file larger than the attributes' `RemainingMemory` is refused before it is sent. A refused part names its code (-1 bad offset, -2 offset mismatch, -3 file could not be opened).

Status mapping. The spec's `PrintInfo.Status` codes (6 paused, 8 stopped, 9 complete) differ from what a Centauri Carbon was seen sending (5 pausing, 8 preparing, 9 starting, 10 paused, 13 printing, 20 resuming). `CurrentStatus` settles it: while it holds 1 (printing), 5, 6 and 10 are paused, 1, 8 and 9 preparing, anything else printing; once it is idle, the sub status keeps its last value, so 9 is finished and 8 is idle with "The print was stopped". `CurrentStatus` 2, 3 and 4 read as idle with "Receiving a file", "Calibrating" or "Running a self check". A nonzero `PrintInfo.ErrorNumber` outside an active print is an error with its reason. Without `CurrentStatus`, the Centauri Carbon codes apply alone. The camera reads as available unless the attributes say `CameraStatus` 0.

Scanning broadcasts `M99999` to UDP 3000 and parses the JSON replies. An IP address typed in setup gets the same `M99999` sent to it alone, so the printer is confirmed, with its name, model and firmware, before the WebSocket is tried.

### Events and rate

Pushed by the printer. Status events fire when anything other than the timestamp changes.

### Testing

`elegoo_sdcp_contract` and `elegoo_reads_attributes_files_and_free_storage` in `tests/drivers.rs`, against a fake with hand written WebSocket framing. The fake's free storage is set with `POST /elegoo {remainingMemory}` on its control port.

### Sources

SDCP V3.0.0: https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0. Centauri Carbon notes: https://github.com/WalkerFrederick/sdcp-centauri-carbon. OpenCentauri SDCP API: https://docs.opencentauri.cc/software/api/.
