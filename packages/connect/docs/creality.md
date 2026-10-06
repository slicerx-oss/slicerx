# Creality

Connects to Creality printers without rooting them: K1, K1C, K1 Max, K1 SE, the K2 family, Ender-3 V3 series and Creality Hi. Live status, temperatures, uploads, start, pause, resume, cancel, G-code lines, the camera, and the spools in a CFS. Printers that run Klipper with Moonraker (the K2 family out of the box, or a rooted K1) use Moonraker automatically, and still report their CFS.

## For users

### On the printer

1. Connect the printer to your network. On the touchscreen, open Settings, then Wi-Fi (or Network for a cable).
2. Tap the connected network to see the IP address. Your router's device list shows it too.
3. Update to recent firmware if you can. Older builds report fewer values. No password, access code or developer mode is needed.

Moonraker, Fluidd and Mainsail are part of stock firmware only on the K2 family (Moonraker on 7125, Fluidd on 4408). On a stock K1, K1C, K1 Max and Ender-3 V3 KE, Moonraker is present but turned off, and reaching it needs root: on the touchscreen open Settings, then Root account information, accept the notice (a K2 asks you to wait 30 seconds, then press Ok), then install Moonraker with a community helper script. SlicerX does not need any of that: the stock interface works without root. Community guides give the default root passwords as creality_2023 (K1 family) and creality_2024 (K2); change it after you log in.

### In SlicerX

1. Add a printer and choose Scan. Stock Creality firmware announces a multicast DNS service of its own (`_Creality-<id>._udp`), which the scan asks for. If yours does not show, use Enter IP instead: SlicerX reads the model and MAC address from the printer's `/info` page, or sees its interface on port 9999.
2. SlicerX finds out which interface the printer offers:

| What answers | What SlicerX uses | Typical printers |
| --- | --- | --- |
| Moonraker on port 7125 or 4408 | Moonraker | K2 family, rooted K1 |
| The Creality Print interface on port 9999 | the native interface | stock K1, K1C, K1 Max, K1 SE, Ender-3 V3 series, Hi |

If a printer answers both, Moonraker is used. To force one, set the protocol to Moonraker or native in the printer's settings.

What works through the native interface: status, temperatures, box temperature where the printer has a sensor, job name, progress, layer and time left, fans, the light, head position, the model and firmware, the CFS spools (material and color), uploading a file, starting it, pause, resume, cancel, G-code lines, and the camera. The K2 family, and a K1 on firmware 1.3.5.22 or later, stream video over WebRTC on port 8000, which SlicerX shows live; other models stream MJPEG on port 8080.

### Network and firewall

| Port | Protocol | Used for |
| --- | --- | --- |
| 9999 | TCP, WebSocket | status and commands |
| 80 | TCP, HTTP | printer info and file upload |
| 8080 | TCP, HTTP | MJPEG camera (K1 on older firmware, Ender, Hi) |
| 8000 | TCP, HTTP | WebRTC camera signaling (K2 family, K1 on firmware 1.3.5.22 and later) |
| 7125 or 4408 | TCP, HTTP | Moonraker, when the printer has it |

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "neither Moonraker nor the Creality interface answered" | Wrong IP, printer off or asleep, or a firewall blocks 9999. |
| Connects but shows no telemetry | Another tool may be holding the connection. Close Creality Print, the phone app and other integrations and try again. |
| A command seems ignored | The native interface gives no reply to commands. If the state does not change, the printer refused it, for example starting while busy. |
| The print did not start after an upload | The file goes into the printer's G-code folder. If the printer has a different folder layout on your firmware, start it from the touchscreen and report the model. |
| Status flips to offline right after a start | Some firmware closes the connection when a print starts. SlicerX reconnects within a few seconds. |
| No camera | Check that the camera works in Creality Print. A K1 or K2 on WebRTC firmware needs port 8000 open. |
| The K2's web page at port 4408 | That is Fluidd, the web page. SlicerX uses Moonraker on 7125 behind it, and never reads the page as the printer's answer. |

### Untested on hardware

The native interface was built from the public behavior of Creality Print and community write-ups, and tested against a simulator, not a printer. Things to check first on your model: that starting a print works (the folder differs by model), that the upload form is accepted, that pausing, resuming and canceling change the state, what the printer reports when a job ends or is stopped, and whether it accepts a second controller while Creality Print is connected.

## For integrators

Plugin id `creality`. Capabilities: status, events, upload, start, pause, resume, cancel, camera, filament slots (when a CFS answers), G-code console. Network: `lan:9999`, `lan:80`, `lan:8080`, `lan:8000`, `lan:7125`, `lan:4408`.

Printer config: `host`, optional `port` (the Moonraker port; probed at 7125 then 4408 when unset, and only a JSON Moonraker answer counts), `wsPort` (default 9999), `httpPort` (default 80), `cameraPort` (default 8080 for MJPEG, 8000 for WebRTC), `protocol` (`moonraker` or `native`), `credentialRef` (a key: `X-Api-Key` for Moonraker, `Authorization: Bearer` for the native interface, as OrcaSlicer sends it), `pollMs` (Moonraker polling).

Discovery: the mDNS browse asks for the list of service types and reports a `_Creality-<id>._udp.local` type as a `creality` printer with `uid` `<id>` (OrcaSlicer's CrealityHostDiscovery). `probe` asks `GET /info` on 80 for `model`, `hostname` and `mac`, then TCP 9999. Model names: board codes F001 Ender-3 V3, F002 Ender-3 V3 Plus, F005 Ender-3 V3 KE, F008 K2 Plus, F012 K2 Pro, F018 Hi, F021 K2, F022 SPARKX i7, read from `model` or `modelVersion`; other models keep the name they report (`CR-K1 Max`, `K1C`).

### Native protocol

- WebSocket `ws://host:9999/` with subprotocol `wsslicer` (ha_creality_ws offers it, as the printer's web UI does); a printer that refuses it is asked again with none, as OrcaSlicer connects. The printer pushes JSON telemetry; members are merged into one state. `{"method":"get","params":{"ReqPrinterPara":1}}` requests the full state and is repeated every ten seconds, `{"method":"get","params":{"boxsInfo":1}}` the CFS boxes, on connect and every 30 seconds. Frames up to 16 MiB and messages up to 64 MiB are read (tungstenite's limits), so a long file list fits. The printer's `{"ModeCode":"heart_beat"}` gets the reply `ok`. After a drop the connection is retried every two seconds and the printer reads as offline meanwhile.
- Commands go out as `{"method":"set","params":...}` with no acknowledgment: `{"pause":1}` pauses, `{"pause":0}` resumes, `{"stop":1}` cancels, `{"gcodeCmd":"..."}` sends a line, `{"opGcodeFile":"printprt:<path>"}` starts a file. The path is `/usr/data/printer_data/gcodes/<name>` on K1 family models and `/mnt/UDISK/printer_data/gcodes/<name>` otherwise, decided from the `model` in `GET /info`. Because there is no acknowledgment, the driver checks the cached state first and returns `bad_state` for a command the state does not allow.
- Upload is `POST /upload/<name>` (spaces become underscores), multipart field `file`, plus an empty `path` field except on the models OrcaSlicer treats as CFS capable (F008, F012, F021, F022, K1, K1 SE, K1C, K1_CFS-C).
- CFS: `boxsInfo.materialBoxs`, read as OrcaSlicer's `parse_cfs_response`: boxes with `state` 1 and `type` 0 (type 1 is the external holder), lettered A, B, ... in order; a slot with a non-zero `state` and a vendor or type is loaded; `#0RRGGBB` colors. A printer reached through Moonraker gets its CFS the same way, asked once over 9999 when setup reads its hardware.
- Other fields: `modelVersion` (`Printer HW Ver: ...; Printer SW Ver: ...`, the firmware), `hostname`, `webrtcSupport`, `curPosition`, `modelFanPct`, `caseFanPct`, `auxiliaryFanPct`, `lightSw`.
- State mapping: non-zero `err.errcode` is error; `withSelfTest` 1 to 99 is preparing; with a file name, progress 100 is finished, `state` 5 paused, 1 printing, 0 preparing, 4 idle; without a file, idle.

### Events and rate

Pushed by the printer roughly every two seconds; a status event fires when anything other than the timestamp changes. A job that leaves printing, paused or preparing for finished, idle or error produces `job_finished`.

### Testing

`creality_native_contract` and the two probe tests in `tests/drivers.rs` run against a fake with the same WebSocket, REST and MJPEG surfaces (`--only creality`). The Moonraker path is covered by `creality_contract_over_moonraker`. `tests/plug_and_play.rs` covers the CFS, board codes, the Bearer key, a refused subprotocol, WebRTC firmware and the probe; `POST /creality` on the control server sets the fake's model, `modelVersion`, `webrtcSupport`, CFS and subprotocol behavior.

### Sources

OrcaSlicer's Creality host, discovery and CFS agent: `src/slic3r/Utils/CrealityPrint.cpp`, `CrealityHostDiscovery.cpp` and `CrealityPrintAgent.cpp` in https://github.com/OrcaSlicer/OrcaSlicer. Telemetry fields, heartbeat, commands, camera modes and model detection: https://github.com/3dg1luk43/ha_creality_ws. Moonraker: https://github.com/Arksine/moonraker (`docs/external_api`).
