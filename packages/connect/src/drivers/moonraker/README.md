# Moonraker (Klipper)

Plugin id `moonraker`, default port 7125. Optional `X-Api-Key`.

## Endpoints used

`GET /server/info` (connection test), `GET /printer/objects/query` (`print_stats`, `virtual_sdcard`, `extruder` to `extruder5`, `heater_bed`, `temperature_sensor chamber`, `heater_generic chamber`), `POST /server/files/upload` (multipart, `root=gcodes`), `POST /printer/print/start|pause|resume|cancel`, `POST /printer/gcode/script`, `GET /server/webcams/list` and the snapshot URL it returns (must be on the printer's host).

Events are polled (`pollMs`, default 1000). Time left is estimated from `print_duration` and progress. A 503 from the query means Klipper is not ready and reports as `error`.

## Sources

- Moonraker web API: https://moonraker.readthedocs.io/en/latest/web_api/

## Unverified

Push events over the WebSocket (`notify_status_update`) are not used yet.
