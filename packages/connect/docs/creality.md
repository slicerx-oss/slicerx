# Creality

Connects to Creality printers without rooting them: K1, K1C, K1 Max, K1 SE, K2 Plus, Ender-3 V3 series and Creality Hi. Live status, temperatures, uploads, start, pause, resume, cancel, G-code lines and camera snapshots. Printers that run Klipper with Moonraker (the K2 series, or a K1 with a community firmware) use Moonraker automatically.

## For users

### On the printer

1. Connect the printer to your network. On the touchscreen, open Settings, then Wi-Fi (or Network for a cable).
2. Tap the connected network to see the IP address. Your router's device list shows it too.
3. Update to recent firmware if you can. Older builds report fewer values. No password, access code or developer mode is needed.

### In SlicerX

1. Add a printer, choose Creality, and enter the IP address. Creality printers on stock firmware are not found by scanning. A Klipper Creality that announces Moonraker does show up in a scan, as a Moonraker printer.
2. SlicerX finds out which interface the printer offers:

| What answers | What SlicerX uses | Typical printers |
| --- | --- | --- |
| Moonraker on port 7125 or 4408 | Moonraker | K2 series, K1 with community Klipper firmware |
| The Creality Print interface on port 9999 | the native interface | stock K1, K1C, K1 Max, K1 SE, Ender-3 V3 series, Hi |

If a printer answers both, Moonraker is used. To force one, set the protocol to Moonraker or native in the printer's settings.

What works through the native interface: status, temperatures, box temperature where the printer has a sensor, job name, progress, layer and time left, uploading a file, starting it, pause, resume, cancel, G-code lines, and camera snapshots on K1, Ender and Hi models. Filament slots (CFS) are not shown. K2 printers stream video over WebRTC, which SlicerX cannot read, so they show no camera.

### Network and firewall

| Port | Protocol | Used for |
| --- | --- | --- |
| 9999 | TCP, WebSocket | status and commands |
| 80 | TCP, HTTP | printer info and file upload |
| 8080 | TCP, HTTP | camera (K1, Ender, Hi) |
| 7125 or 4408 | TCP, HTTP | Moonraker, when the printer has it |

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "neither Moonraker nor the Creality interface answered" | Wrong IP, printer off or asleep, or a firewall blocks 9999. |
| Connects but shows no telemetry | Another tool may be holding the connection. Close Creality Print, the phone app and other integrations and try again. |
| A command seems ignored | The native interface gives no reply to commands. If the state does not change, the printer refused it, for example starting while busy. |
| The print did not start after an upload | The file goes into the printer's G-code folder. If the printer has a different folder layout on your firmware, start it from the touchscreen and report the model. |
| Status flips to offline right after a start | Some firmware closes the connection when a print starts. SlicerX reconnects within a few seconds. |
| No camera | K2 printers cannot be read. On others, check that the camera works in Creality Print. |

### Untested on hardware

The native interface was built from the public behavior of Creality Print and community write-ups, and tested against a simulator, not a printer. Things to check first on your model: that starting a print works (the folder differs by model), that the upload form is accepted, that pausing, resuming and canceling change the state, and what the printer reports when a job ends or is stopped.

## For integrators

Plugin id `creality`. Capabilities: status, events, upload, start, pause, resume, cancel, camera (not K2), G-code console. Network: `lan:9999`, `lan:80`, `lan:8080`, `lan:7125`, `lan:4408`.

Printer config: `host`, optional `port` (the Moonraker port; probed at 7125 then 4408 when unset), `wsPort` (default 9999), `httpPort` (default 80), `cameraPort` (default 8080), `protocol` (`moonraker` or `native`), `credentialRef` (Moonraker API key), `pollMs` (Moonraker polling).

### Native protocol

- WebSocket `ws://host:9999/` with subprotocol `wsslicer`. The printer pushes JSON telemetry; members are merged into one state. `{"method":"get","params":{"ReqPrinterPara":1}}` requests the full state and is repeated every ten seconds. The printer's `{"ModeCode":"heart_beat"}` gets the reply `ok`. After a drop the connection is retried every two seconds and the printer reads as offline meanwhile.
- Commands go out as `{"method":"set","params":...}` with no acknowledgment: `{"pause":1}` pauses, `{"pause":0}` resumes, `{"stop":1}` cancels, `{"gcodeCmd":"..."}` sends a line, `{"opGcodeFile":"printprt:<path>"}` starts a file. The path is `/usr/data/printer_data/gcodes/<name>` on K1 family models and `/mnt/UDISK/printer_data/gcodes/<name>` otherwise, decided from the `model` in `GET /info`. Because there is no acknowledgment, the driver checks the cached state first and returns `bad_state` for a command the state does not allow.
- Upload is `POST /upload/<name>` (spaces become underscores), multipart field `file`, plus an empty `path` field on models before the K2 platform.
- State mapping: non-zero `err.errcode` is error; `withSelfTest` 1 to 99 is preparing; with a file name, progress 100 is finished, `state` 5 paused, 1 printing, 0 preparing, 4 idle; without a file, idle.

### Events and rate

Pushed by the printer roughly every two seconds; a status event fires when anything other than the timestamp changes. A job that leaves printing, paused or preparing for finished, idle or error produces `job_finished`.

### Testing

`creality_native_contract` and the two probe tests in `tests/drivers.rs` run against a fake with the same WebSocket, REST and MJPEG surfaces (`--only creality`). The Moonraker path is covered by `creality_contract_over_moonraker`.

### Sources

OrcaSlicer's Creality host: https://github.com/OrcaSlicer/OrcaSlicer/blob/main/src/slic3r/Utils/CrealityPrint.cpp. Telemetry fields, heartbeat and commands: https://github.com/3dg1luk43/ha_creality_ws. Moonraker: https://moonraker.readthedocs.io/en/latest/web_api/.
