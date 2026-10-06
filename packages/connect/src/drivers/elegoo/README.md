# Elegoo Centauri Carbon (SDCP)

Plugin id `elegoo`, port 3030. No authentication.

## Wire protocol

- WebSocket `ws://host:3030/websocket`, JSON envelopes `{Id, Data:{Cmd, Data, RequestID, MainboardID, TimeStamp, From}, Topic}`. Send `ping` every 20 seconds because the printer closes idle sockets after 60.
- `Cmd 0` refreshes status, `1` asks for the attributes (`sdcp/attributes`), `128` starts (`Filename` `/local/name.gcode`), `129` pauses, `130` stops, `131` resumes, `258` lists files, `386` enables the MJPEG stream and returns its URL. Replies carry `Ack` (0 ok, 1 busy, 2 file not found, 3 to 7 the start's file errors), each mapped to its own error.
- Status: `CurrentStatus` (0 idle, 1 printing, 2 file transfer, 3 calibrating, 4 self check) decides how `PrintInfo.Status` reads. While printing, the Centauri Carbon codes: 5, 6 and 10 paused, 1, 8 and 9 preparing, others printing. Once idle, the spec's last sub status: 9 finished, 8 stopped. A nonzero `ErrorNumber` outside a print is an error. Temperatures come from `TempOfNozzle`, `TempOfHotbed` and `TempOfBox` with their `Target` fields. `Progress` is a percentage.
- Attributes: `MachineName`, `FirmwareVersion` and `MainboardID` fill the hardware; `CameraStatus` the camera; `RemainingMemory` (read as bytes) is checked before an upload.
- Upload: chunked `POST /uploadFile/upload` (1 MiB per request) with the form fields `Check`, `S-File-MD5`, `Offset`, `Uuid`, `TotalSize` and `File`. A refused part names its code (-1 to -4).
- `sdcp/error` messages become error events. A connection that gets no status within 8 seconds says the printer may already serve its limit of apps.
- Discovery: UDP broadcast of `M99999` to port 3000, sent only when the user starts a scan. A typed IP address gets the same `M99999` sent to it alone (`probe`), which confirms the printer and reads its name, model, mainboard id and firmware.

There is no G-code console. Klipper based Elegoo models (Neptune 4) use the Moonraker plugin.

## Sources

- SDCP V3.0.0 specification: https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0
- Centauri Carbon notes: https://github.com/WalkerFrederick/sdcp-centauri-carbon
- OpenCentauri SDCP API: https://docs.opencentauri.cc/software/api/

## Unverified

The Centauri Carbon specific status codes come from a community write-up and conflict with the spec; `CurrentStatus` is used to tell them apart, which is untested on a printer. The upload form fields follow the SDCP spec and are untested against a printer. `TotalTicks` and `CurrentTicks` are read as seconds (the spec says milliseconds) and `RemainingMemory` as bytes (the spec says bits). `StartLayer` is always 0.
