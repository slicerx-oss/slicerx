# Bambu Lab LAN

Plugin id `bambu-lan`. LAN mode with the printer's access code. X1, P1, A1 and H2D families.

## Wire protocol

- MQTT 3.1.1 over TLS on 8883, user `bblp`, password is the access code. Subscribe to `device/{serial}/report`, publish to `device/{serial}/request`. Every session signs in with its own client id: the broker closes a connection when another signs in with the same id, and two sessions sharing one take turns being offline. The bridge keeps one session per printer.
- `{"pushing":{"command":"pushall",...}}` requests the full state. Reports with `print.command == "push_status"` are merged key by key at every depth, as Bambu Studio's `json_diff::diff2all` does, because P1, A1 and H2D printers send only what changed (`msg` 1 on the H2D, `msg` 0 for a full report), objects included part by part. Arrays are replaced whole.
- Commands: `pause`, `resume`, `stop` (cancel), `gcode_line`, `project_file` for `.gcode.3mf` (FTPS path in `url`, `ams_mapping` as global tray ids, `-1` for unused filaments), `gcode_file` for plain G-code. The wire key `bed_levelling` uses the protocol's spelling.
- FTPS: implicit TLS on 990, same credentials, passive mode, `STOR` into the root. The client is in `src/ftps.rs`.
- Camera: A1 and P1 stream JPEG frames on TLS port 6000 after an 80 byte authentication packet. X1 and H2 printers serve H.264 over RTSPS on 322 (`/streaming/live/1`, Digest or Basic login, TLS 1.2), only while LAN Only Liveview is on. The report says which, read as Bambu Studio reads it: `ipcam.liveview.local`, then `ipcam.rtsp_url`, where `disable` means liveview is off. Then `stream` fails with a line telling the person to turn it on. A report that says neither is tried on 6000, then on 322. The H2D reports `rtsp_url` and no `liveview` key, which is enough to go straight to 322; the path and port come from that URL. `snapshot` reads port 6000 only, and on a printer whose report names RTSPS it returns `None` without trying. Some cameras send SPS and PPS in band as units of their own and not in the SDP; the depacketizer keeps the last ones and puts them in front of each key frame that lacks them, so a decoder can start there.
- Discovery: SSDP `NOTIFY` broadcasts on UDP 2021 and 1990, parsed by `parse_ssdp`.

## Normalization

`gcode_state` maps to idle, printing, paused, finished, error and preparing. AMS trays become slots `A1` to `D4` (unit letter, tray number), colors `#rrggbb`, unknown remaining weight (`-1`) is omitted. H2D nozzles come from `device.extruder.info[].temp` with the current temperature in the low 16 bits and the target in the high 16. `mc_remaining_time` is read as minutes.

## Sources

- Doridian/OpenBambuAPI: https://github.com/Doridian/OpenBambuAPI (`mqtt.md`, `ftp.md`, `video.md`)
- Community reports for H2D temperature packing and model codes (see comments in `mod.rs`).

## Unverified

Never run against a printer. The H2D layout, the `ftp:///` URL in `project_file`, and `mc_remaining_time` units come from community documentation and are the first things to check on hardware. The docs disagree on whether `mc_remaining_time` is minutes or seconds.
