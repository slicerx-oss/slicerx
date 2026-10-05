# Elegoo Centauri Carbon (SDCP)

Plugin id `elegoo`, port 3030. No authentication.

## Wire protocol

- WebSocket `ws://host:3030/websocket`, JSON envelopes `{Id, Data:{Cmd, Data, RequestID, MainboardID, TimeStamp, From}, Topic}`. Send `ping` every 20 seconds because the printer closes idle sockets after 60.
- `Cmd 0` refreshes status, `128` starts (`Filename` `/local/name.gcode`), `129` pauses, `130` stops, `131` resumes, `386` enables the MJPEG stream and returns its URL. Replies carry `Ack` (0 ok, 2 file not found).
- Status: `PrintInfo.Status` 13 and 20 printing, 5 and 10 paused, 8 and 9 preparing, otherwise idle. Temperatures come from `TempOfNozzle`, `TempOfHotbed` and `TempOfBox` with their `Target` fields. `Progress` is a percentage.
- Upload: chunked `POST /uploadFile/upload` (1 MiB per request) with the form fields `Check`, `S-File-MD5`, `Offset`, `Uuid`, `TotalSize` and `File`.
- Discovery: UDP broadcast of `M99999` to port 3000, sent only when the user starts a scan. A typed IP address gets the same `M99999` sent to it alone (`probe`), which confirms the printer and reads its name, model, mainboard id and firmware.

There is no G-code console. Klipper based Elegoo models (Neptune 4) use the Moonraker plugin.

## Sources

- SDCP V3.0.0 specification: https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0
- Centauri Carbon notes: https://github.com/WalkerFrederick/sdcp-centauri-carbon

## Unverified

The Centauri Carbon specific status codes come from a community write-up. A completed print has no documented code and reports as idle. The upload form fields follow the SDCP spec and are untested against a printer. `TotalTicks` and `CurrentTicks` are read as seconds.
