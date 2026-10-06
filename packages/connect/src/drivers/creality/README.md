# Creality

Plugin id `creality`. Two protocols, picked by probing when the printer config does not set `protocol`:

1. Moonraker, for Klipper models (the K2 family on stock firmware, and a rooted K1). The driver is the Moonraker driver (`../moonraker/README.md`) with this plugin id. Probed on the configured port, or 7125 then 4408; only a JSON Moonraker answer counts, so Fluidd's page on a K2's 4408 is never taken for the API. Setup still reads the CFS over 9999 (`query_boxes`).
2. The native interface stock firmware exposes to Creality Print (`native.rs`), for K1, K1 Max, K1C, K1 SE, K2 Plus, Ender-3 V3 series and Creality Hi. Probed by opening TCP 9999.

`protocol: "moonraker"` or `protocol: "native"` skips the probe. Moonraker wins when both answer, because it is the richer interface.

## Native interface

- Telemetry over WebSocket `ws://host:9999/` with the subprotocol `wsslicer`, and with none when the printer refuses it (OrcaSlicer offers none). The printer pushes JSON objects whose members are merged into one state. `{"method":"get","params":{"ReqPrinterPara":1}}` asks for the full state and is repeated every 10 seconds. The printer's `{"ModeCode":"heart_beat"}` frames are answered with the text `ok`.
- `{"method":"get","params":{"boxsInfo":1}}` on connect and every 30 seconds for the CFS, parsed as OrcaSlicer's `parse_cfs_response` does.
- Fields read: `model`, `modelVersion`, `hostname`, `webrtcSupport`, `curPosition`, `modelFanPct`, `caseFanPct`, `auxiliaryFanPct`, `lightSw`, `boxsInfo`, `nozzleTemp`, `targetNozzleTemp`, `bedTemp0`, `targetBedTemp0`, `boxTemp`, `targetBoxTemp`, `state`, `err.errcode`, `withSelfTest`, `printFileName`, `printProgress` (percent), `layer`, `TotalLayer`, `printLeftTime` (seconds). Numbers sometimes arrive as strings.
- State: a non-zero `err.errcode` is error; `withSelfTest` from 1 to 99 is preparing; with a file name, progress 100 is finished, `state` 5 paused, 1 printing, 0 preparing, 4 (stopped) idle; without a file, idle.
- Commands are `{"method":"set","params":{...}}` with no acknowledgment: `{"pause":1}` and `{"pause":0}`, `{"stop":1}`, `{"gcodeCmd":"..."}`, and `{"opGcodeFile":"printprt:<path>"}` to start. The path is `/usr/data/printer_data/gcodes/<name>` on K1 family models and `/mnt/UDISK/printer_data/gcodes/<name>` on the others, chosen from the `model` that `GET /info` reports.
- Upload: `POST http://host/upload/<name>` (spaces in names become underscores), multipart field `file`, plus an empty `path` field except on OrcaSlicer's CFS capable models (F008, F012, F021, F022, K1, K1 SE, K1C, K1_CFS-C). A key, when set, goes as `Authorization: Bearer` on `/info` and uploads, as OrcaSlicer sends it.
- Camera: MJPEG at `http://host:8080/?action=stream`; WebRTC signaling at `http://host:8000/call/webrtc_local` on the K2 family and on K1 firmware that reports `webrtcSupport` 1 (ha_creality_ws), where `stream` and `snapshot` return `None` and `webrtc_offer` answers.
- Probe: `GET /info` (`model`, `hostname`, `mac`), then TCP 9999. Board codes read as model names (`model_name`).

## Sources

- OrcaSlicer's Creality host, which uploads and starts prints the way Creality Print does, its discovery and its CFS agent: `CrealityPrint.cpp`, `CrealityHostDiscovery.cpp`, `CrealityPrintAgent.cpp` in https://github.com/OrcaSlicer/OrcaSlicer/tree/main/src/slic3r/Utils
- Telemetry fields, state codes, the heartbeat and the `set` commands: https://github.com/3dg1luk43/ha_creality_ws (`ws_client.py`, `utils.py`, and the test server in `tools/`)
- Moonraker API: https://moonraker.readthedocs.io/en/latest/web_api/

## Source licenses

OrcaSlicer's sources named above and `ha_creality_ws` are AGPL-3.0 projects. They were read as protocol references only: message names, field names, ports, URLs, paths and state codes, which are facts about the printer's interface. The Rust driver, its structure and its tests were written for this crate from those facts and do not copy or translate their code. The mock printer was written the same way.

## State table to re-derive

`parse_status` in `native.rs` maps telemetry to a state in this order: error code, self-test range, the `dProgress` fallback, then the state codes 5, 1, 0 and 4. That order and those codes come from the community integration named above, not from captures of a real printer. When hardware is available, record telemetry during idle, heating, printing, pausing, resuming, stopping, finishing and an error, re-derive the table from those captures, and cite the captures here (model, firmware version, date). Until then, treat the mapping as provisional.

## Untested on hardware

Everything in the native interface was written from those sources and the mock, not from a printer. Check first: the `opGcodeFile` start command per model (the data root; Ender-3 V3 and Hi follow OrcaSlicer's `/mnt/UDISK` default, unconfirmed), the `path` upload field per model, the CFS reply on a K1C and Hi, whether a second controller is refused while Creality Print is connected, what `state` and `err` do around finish and stop, and whether firmware closes the WebSocket after a start (the link reconnects every two seconds). The 4408 probe for the K2 is a community report. No acknowledgment exists for commands, so a refused command shows only as an unchanged state.
