# Bambu Lab LAN

Plugin id `bambu-lan`. LAN mode with the printer's access code. X1, P1, P2S, A1 and H2 families. The serial number is read from the MQTT certificate's common name when the config has none.

## Wire protocol

- MQTT 3.1.1 over TLS on 8883, user `bblp`, password is the access code. Subscribe to `device/{serial}/report`, publish to `device/{serial}/request`. Every session signs in with its own client id: the broker closes a connection when another signs in with the same id, and two sessions sharing one take turns being offline. The bridge keeps one session per printer.
- `{"pushing":{"command":"pushall",...}}` requests the full state. Reports with `print.command == "push_status"` are merged key by key at every depth, as Bambu Studio's `json_diff::diff2all` does, because P1, A1 and H2D printers send only what changed (`msg` 1 on the H2D, `msg` 0 for a full report), objects included part by part. Arrays are replaced whole.
- Commands: `pause`, `resume`, `stop` (cancel), `gcode_line`, `project_file` for `.gcode.3mf` (`url` `file:///sdcard/<path>` on the X1, P1 and A1 families and `ftp:///<path>` otherwise, as ha-bambulab sends it; `ams_mapping` as global tray ids, an AMS HT as its unit id (128 to 135), `-1` for unused filaments), `gcode_file` for plain G-code. The wire key `bed_levelling` uses the protocol's spelling. The printer answers `project_file`, `gcode_file`, `pause`, `resume`, `stop` and `ams_filament_setting` on the report topic with the request's `sequence_id`, a `result` and a `reason`; a `fail` is a refusal, returned with that reason. Pause, resume, stop and `gcode_file` also settle when the report shows the change, and stand as sent after 3 s with neither.
- FTPS: implicit TLS on 990, same credentials, passive mode, `STOR` into the root. The client is in `src/ftps.rs`. An upload is refused first when the report gives no SD card (and `fun2` bit 0 does not say internal storage), or a faulty or read only one (`sd_card`, `storage_problem`).
- Model: `print.printer_type` when it is a known code (`model_from_report`), else `get_version`.
- Camera: A1 and P1 stream JPEG frames on TLS port 6000 after an 80 byte authentication packet. X1 and H2 printers serve H.264 over RTSPS on 322 (`/streaming/live/1`, Digest or Basic login, TLS 1.2), only while LAN Only Liveview is on. The report says which, read as Bambu Studio reads it: `ipcam.liveview.local`, then `ipcam.rtsp_url`, where `disable` means liveview is off. Then `stream` fails with a line telling the person to turn it on. A report that says neither is tried on 6000, then on 322. The H2D reports `rtsp_url` and no `liveview` key, which is enough to go straight to 322; the path and port come from that URL. `snapshot` reads port 6000 only, and on a printer whose report names RTSPS it returns `None` without trying. Some cameras send SPS and PPS in band as units of their own and not in the SDP; the depacketizer keeps the last ones and puts them in front of each key frame that lacks them, so a decoder can start there.
- Discovery: SSDP `NOTIFY` broadcasts on UDP 2021 and 1990 and answers to a search, parsed by `parse_ssdp` (`DevBind` fills `bound`).

## Normalization

`gcode_state` maps to idle, printing, paused, finished, error and preparing. AMS trays become slots `A1` to `D4` (unit letter, tray number) and AMS HT units (ids 128 to 135, one slot each) `E1` to `L1`, colors `#rrggbb`, unknown remaining weight (`-1`) is omitted. A loaded external spool is a slot after them: `1` for `vt_tray` on single nozzle printers; on H2 printers `vir_slot` 254 (the left nozzle's) is `1` and 255 (the right's) is `2`. A slot map sends them as -1 in `ams_mapping` and by those ids (254, 255) in `ams_mapping2`; slot `2` and AMS HT slots are refused on a printer whose status does not list them. While a job prepares, prints or is paused with nothing wrong, `stg_cur` gives the status message (the step, in our own words). The chamber target comes from `ctt` or the packed `device.ctc.info.temp`, and the P1P, P1S, A1, A1 mini and A2L report no chamber temperature. H2D nozzles come from `device.extruder.info[].temp` with the current temperature in the low 16 bits and the target in the high 16. `mc_remaining_time` is read as minutes.

## Sources

- Doridian/OpenBambuAPI: https://github.com/Doridian/OpenBambuAPI (`mqtt.md`, `ftp.md`, `video.md`)
- Bambu Studio's behaviour with the same printers: how it reads `printer_type`, `home_flag`, `aux` and `fun2`, and the checks before a LAN send
- ha-bambulab: `pybambu/const.py` (`LEGACY_SDCARD_PRINTERS`)
- Community reports for H2D temperature packing and model codes (see comments in `mod.rs`).

## Unverified

Never run against a printer. The H2D layout, the `project_file` URL per model, and `mc_remaining_time` units come from community documentation and are the first things to check on hardware. The docs disagree on whether `mc_remaining_time` is minutes or seconds.
