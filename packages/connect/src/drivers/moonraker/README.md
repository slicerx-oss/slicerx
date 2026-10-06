# Moonraker (Klipper)

Plugin id `moonraker`, default port 7125. Sign-in: none (a trusted client), `X-Api-Key`, or a user login (`POST /access/login`, `Authorization: Bearer`, renewed with `POST /access/refresh_jwt`).

## Endpoints used

`GET /server/info` (connection test; a configured port that answers with something else is retried on 7125), `GET /printer/objects/list` once, `GET /printer/objects/query` (`print_stats`, `virtual_sdcard`, `webhooks`, the extruders the object list names, `heater_bed`, chamber sensors, `fan`, `gcode_move`, and `mmu`, `save_variables` with `box_stepper slot<N>`, `print_task_config` when present), `POST /server/files/upload` (multipart, `root=gcodes`, `checksum`, `print=false`), `POST /printer/print/start|pause|resume|cancel`, `POST /printer/gcode/script`, `GET /server/webcams/list` once per session and the URLs it returns (enabled webcams only; relative URLs against the web frontend's port; absolute ones only on the printer's host), `GET /server/files/metadata` with the file list as fallback on 404, and `/server/files/config/officiall_filas_list.cfg` on a printer with a QIDI Box.

Events are polled (`pollMs`, default 1000). Time left is estimated from `print_duration` and progress. A `webhooks` state other than `ready`, or a 503 from the query, reports as `error` with Klipper's own message.

Filament units: `filament.rs` (Happy Hare MMU, QIDI Box, Snapmaker U1).

## Sources

- Moonraker API and authorization: the `docs/external_api` pages of https://github.com/Arksine/moonraker
- OrcaSlicer `src/slic3r/Utils`: `MoonrakerPrinterAgent.cpp` (`machine_name`, the upload's five minute limit), `QidiPrinterAgent.cpp` (QIDI Box), `SnapmakerPrinterAgent.cpp` (U1 toolheads)

## Unverified

Push events over the WebSocket (`notify_status_update`) are not used yet. Webcam orientation is read but not applied.
