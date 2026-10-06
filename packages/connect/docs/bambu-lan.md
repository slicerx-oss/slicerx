# Bambu Lab (LAN mode)

Connects to Bambu Lab X1, X1 Carbon, X1E, P1P, P1S, P2S, A1, A1 mini and H2 series printers over your local network: live status, AMS filament slots, uploads, start, pause, resume, cancel, camera and G-code lines. Bambu's cloud is not used.

## For users

### On the printer

Connect the printer to your network first. Then, on the printer's screen (paths from Bambu Lab's wiki, "Enable Developer Mode"):

| Series | LAN Only Mode and Developer Mode | IP address |
| --- | --- | --- |
| X1, X1 Carbon, X1E | Settings, then LAN Only | the LAN Only page |
| H2D, H2S, H2C, P2S | Settings, then LAN Only | the LAN Only page |
| P1P, P1S | Settings, then WLAN, then LAN Only Mode; Developer Mode is further down the WLAN page | the WLAN page |
| A1, A1 mini | Settings, page 3, then LAN Only Mode | the WLAN page |

1. Turn on LAN Only Mode. The access code (8 characters) is on the same page. Read it from the printer when you add it, and again if the printer later refuses it.
2. Turn on Developer Mode on the same page, read the notice and enable it. Printers on firmware X1 01.08.03.00, P1 01.08.02.00, A1 01.05.00.00, H2D 01.01.00.01 or newer refuse prints from other apps without it. SlicerX warns when a printer reports it off.
3. On X1 and H2 series printers, turn on LAN Only Liveview too if you want the camera.
4. A printer in LAN Only Mode keeps a file sent over the network on its micro SD card, so put one in (an X1 cannot start a network print without it). SlicerX says so before uploading when the printer reports no card, a faulty one or a read only one, unless the printer reports it can print from its internal storage.
5. You do not need the serial number: a scan reads it, and so does SlicerX from the printer's certificate when you enter only the IP address.

While LAN Only Mode is on, the printer does not use Bambu's cloud, so the Bambu phone app and cloud printing stop working for it. Menu names differ between models and firmware versions.

### In SlicerX

1. Add a printer and choose Scan. Bambu Lab printers announce themselves on the network, and SlicerX only listens, so yours appears within a few seconds with its serial number filled in.
2. If it does not appear, use Enter IP instead with the printer's IP address. SlicerX asks the printer directly and reads the serial number from its certificate.
3. Enter the access code. SlicerX stores it in your keychain and never shows it again.

The printer's controls page reads the files on the printer's storage, the prints it saw end, and what the printer reports as wrong. The most common problems (filament runout, AMS feed trouble, a clogged nozzle, heater faults, an open door, first layer inspection and spaghetti findings) read in plain words; every other code links to its page on the Bambu Lab wiki. Objects can be skipped for prints sent from SlicerX, since the printer does not list them; for prints sent some other way, skip them on the printer's screen.

### Network and firewall

The computer needs to reach the printer on:

| Port | Protocol | Used for |
| --- | --- | --- |
| 8883 | TCP, MQTT over TLS | status and commands |
| 990 | TCP, FTPS | uploading files (data connections use high ports the printer chooses, commonly 50000 to 50100) |
| 6000 | TCP, TLS | camera frames on A1 and P1 |
| 322 | TCP, RTSPS | camera on X1, X1E, P2S and H2 series, while LAN Only Liveview is on |
| 2021 and 1990 | UDP | the printer's announcements and answers to a search, for scanning |

Guest Wi-Fi networks and VLANs that isolate clients block all of these.

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "rejected the credentials" | The access code is wrong or has changed. Read it again from the printer's screen. |
| "no status report after connecting; check the serial number" | The serial number does not match the printer at that address. |
| "is unreachable" | Wrong IP, printer asleep or off, different subnet or VLAN, or a firewall blocks 8883. |
| "there is no SD card in the printer" | Insert a micro SD card. A card the printer calls faulty or read only gets its own message; check it or format it on the printer. |
| Upload fails or times out | Port 990 or the passive data ports are blocked, or the SD card is full. |
| A command is refused | Developer Mode is off on firmware that requires it, or the printer is in a state that does not allow it (for example pausing while idle). |
| No camera on an X1, P2S or H2 printer | These stream over RTSPS on port 322 only while LAN Only Liveview is on. Turn it on on the printer's screen. |
| Filament slots look wrong | Slots read from the AMS as A1 to A4 for the first unit, B1 to B4 for the next. Third party spools without a tag report no remaining percent. A tagged spool's `tray_uuid` is its `spoolUid`, so the app knows when a slot gets another spool (the drying note's "It's dry" lasts until then, or 7 days). |

### Untested on hardware

Checked against a simulator, not a printer. First things to check: H2D nozzle temperatures, whether `Developer Mode` is required on your firmware, and the estimated time left (community documentation disagrees on its unit; SlicerX reads minutes).

## For integrators

Plugin id `bambu-lan`. Capabilities: status, events, upload, start, pause, resume, cancel, camera, filament slots, G-code console, and the device page's files, history, problems and skip objects. Network: `lan:8883`, `lan:990`, `lan:6000`, `lan:322`, `lan:1990`, `lan:2021`. Tools: `bambu-lan.status` (read), `.queue` (queue), `.start`, `.pause`, `.resume`, `.cancel`, `.gcode` (start).

Printer config: `host`, `credentialRef` (keychain entry with the access code), optional `serial` (read from the MQTT certificate's common name when absent), `port` (8883), `ftpPort` (990) and `cameraPort` (6000).

### Protocol

- MQTT 3.1.1 over TLS, user `bblp`, password is the access code. Subscribe to `device/{serial}/report`, publish to `device/{serial}/request`. The connection goes ahead whatever the certificate; whether a Bambu Lab CA issued it for this serial (BBL CA, BBL CA2 RSA or ECC, directly or through a device CA the printer sends, such as BBL Device CA N7-V2) is recorded for the printer test and never refuses the printer. The access code is the credential.
- The model comes from `print.printer_type` in the reports when it is a known code, read as Bambu Studio's `_parse_printer_type` reads it (`3DPrinter-X1` is BL-P002, `3DPrinter-X1-Carbon` BL-P001); it alone separates an X1 from an X1 Carbon. Else one `get_version` on connect: a module's `project_name` is the model code (`N2S` A1, `N1` A1 mini, the `model_id` values of Orca 2.4.2's BBL profiles), else `product_name`. The hub adds it to the status as `model`, and the Print sheet's options and bed check go by it over the model the printer was added as.
- The printer's own name ("Tawain #1") comes only from its SSDP announcement (`DevName.bambu.com`); neither `push_status` nor `get_version` carries it. The hub keeps each announced name by serial, from `printers.discover` and from a passive six second listen it starts at most once a minute while a registered Bambu Lab printer's name is unknown, and adds it to that printer's status as `ownName`. The app shows a printer under `ownName` when it was added under its model alone ("H2D" or "Bambu Lab H2D"), with the model beneath it; a name the person typed always wins (`packages/app/src/lib/printer-name.ts`).
- Slots: AMS trays as A1 to A4 (B1 to B4 for a second unit), then the external spool (`vt_tray`) as slot `1` whenever it holds a typed filament, beside an AMS lite or without one. An A1 or A1 mini with no AMS lite has the external spool only, and a print from it goes out with `ams_mapping` -1 and `use_ams` false.
- On connect, one `pushall` requests the full state. Documentation says P1 printers should not receive it more than every five minutes; SlicerX sends it once per connection. Later `push_status` reports carry only what changed and are merged.
- The Print sheet sends a Bambu Lab printer the plate as a `.gcode.3mf` (one plate, written as plate 1): the G-code with its MD5 in capitals, `slice_info.config` with the printer's model id, nozzle, the objects by the ids the G-code labels (so the printer's own skip list works), the filaments it uses, `plate_1.json` with each object's box, and the plate picture from the G-code's thumbnails. Bambu Studio's `top_1.png`, `pick_1.png`, `plate_no_light_1.png` and `filament_sequence.json` are left out: the printer does not need them to print, and drawing them takes a 3D render.
- A slot edited in SlicerX can be written back to the AMS with Set on printer in the slot dialog, the way Bambu Studio writes a slot it edits (`MachineObject::command_ams_filament_settings`): `ams_filament_setting` with `ams_id`, `slot_id` and `tray_id` (the external spool is `ams_id` 255 with `tray_id` 254), the filament preset's `filament_id` as `tray_info_idx`, an empty `setting_id`, `tray_color` as `RRGGBBAA`, the preset's `nozzle_temp_min` and `nozzle_temp_max`, and `tray_type`. As in Studio, a spool with an RFID tag is read only. It is a `printer.adjust` card whose params are `{printerId, slot}`, so only a person approves it; the hub takes `adjust.slot` from the app alone and not while a print runs, then answers with the slot as the printer reports it.
- The status carries a `live` part for the device view, read as Bambu Studio reads it: fan speeds from `fan_gear` or the 0 to 15 gears `cooling_fan_speed`, `big_fan1_speed` and `big_fan2_speed` in steps of 10 percent (DevFan), the speed level `spd_lvl` (1 silent 50 %, 2 standard 100 %, 3 sport 124 %, 4 ludicrous 166 %), the chamber light from `lights_report`, the slot feeding now from the current extruder's `snow` on H2 printers or `ams.tray_now` (DevExtruderSystem), and the nozzle each AMS feeds from bits 8 to 11 of its `info`. A speed change is `print_speed` with the level, on a `printer.adjust` card a person approves. The chamber light is `ledctrl` for `chamber_light` and `chamber_light2` (DevLamp); the hub takes `adjust.light` from the app alone and mints its token itself, like the switch on the printer's screen.
- `project_file` starts a `.gcode.3mf` uploaded over FTPS (`param` `Metadata/plate_N.gcode`). The `url` is `file:///sdcard/name` for the X1, X1 Carbon, X1E, P1P, P1S, A1 and A1 mini and `ftp:///name` for the rest and for a model not known yet, as ha-bambulab lists them (`LEGACY_SDCARD_PRINTERS`). The `slotMap` in start options (0 based filament index to slot id) becomes the three fields Bambu Studio and Orca 2.4.2 send (`SelectMachineDialog::get_ams_mapping_result`): `ams_mapping`, one entry per filament with the global tray index (unit times four plus slot, 0 to 15) and -1 for the external spool or an unused filament; `ams_mapping2`, one `{ams_id, slot_id}` per filament (254 and 0 for the external spool, 255 and 255 for none); and `use_ams`, false when only the external spool feeds the print. Studio sizes the arrays to the project's filament count; SlicerX ends them at the highest mapped filament, which covers every filament the plate uses. Plain `.gcode` starts with `gcode_file`, which has no mapping: the printer feeds each filament from the slot its G-code names, so a plain `.gcode` start with a slot map is refused.
- After a `project_file` start the driver waits up to 10 s for the printer's answer on the report topic (`command` `project_file`, `result` "success" or "fail", `reason`, sometimes `err_code`), the job showing as prepared or printing, or a new `print_error` with the job failed. A refusal is error code `refused` with the printer's reason. The Print sheet then opens again with that reason and offers "Send as plain G-code" as the person's own choice, saying that the printer then feeds filament 1 from slot 1 and so on. Nothing falls back by itself.
- The Print sheet starts each filament on a loaded slot of the same material, closest color first, and will not start while a filament has no slot.
- Print options on start: `bed_levelling`, `flow_cali`, `vibration_cali`, `layer_inspect` and `timelapse` in `project_file`. Defaults follow what Bambu Studio sends (read from `SelectMachine.cpp`): bed leveling on, flow calibration off, vibration compensation off, first layer inspection on, timelapse off. Studio's Auto mode for leveling and flow calibration sends the boolean false plus a separate mode value whose wire key is not public, so SlicerX offers on and off only. Studio turns timelapse on when the printer can record one; SlicerX cannot tell, so it waits to be asked.
- FTPS is implicit TLS on 990 with the same credentials. `.bgcode` files are refused. Before an upload, the storage the report gives is checked as Bambu Studio checks it before a LAN send (`PrintStatusLanModeNoSdcard`): `aux` bits 12 and 13 where the firmware sends `aux`, else `sdcard` refined by `home_flag` bits 8 and 9 (0 none, 1 normal, 2 abnormal, 3 read only). No card is refused unless `fun2` bit 0 says the printer prints from internal storage; an abnormal or read only card is refused.
- Camera on port 6000: an 80 byte authentication packet, then 16 byte frame headers followed by JPEG data.
- Discovery sends one SSDP `M-SEARCH` for `urn:bambulab-com:device:3dprinter:1` and listens for the answers and for `NOTIFY` broadcasts. The answer's `DevModel`, `USN`, `DevVersion`, `DevConnect` and `DevBind` headers give the model, serial number, firmware, whether LAN Only Mode is on, and whether the printer is bound to a Bambu account (`bound`). `Devseclink`, `DevInf` and `DevCap` are not read: no source says what their values mean. A probe of a typed address sends the search to it and, when SSDP is blocked, reads the serial from the MQTT certificate.
- Files: `LIST` over the same FTPS login, in the root (LAN uploads) and `cache` (cloud prints), `.3mf` and `.gcode` only. Size and the listed time are the file info the hub compares with its upload record, so a file changed on the printer reads as unverified.
- History: the LAN protocol keeps none. The session records each print it sees end (`FINISH`, or `FAILED` with `print_error` `0300_400C` or `0500_400E` read as canceled), with `gcode_start_time`, and the last job the report still shows.
- Skip objects: `skip_objects` with `obj_list` of the label ids (`M624` in the G-code). The printer reports skipped ids in `s_obj`. The hub accepts only ids of the plate it started with `objects` (`print.local`), for the job running now.
- Homing: `home_flag` bits 0 to 2 are X, Y and Z homed (0 means not reported). The report has no head position, so jog only lifts Z.
- Problems: `hms` entries (module, part, severity, error) and `print_error`. A small table of our own wording covers the common codes (`drivers/bambu/hms.rs`); the rest link to `https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/<code>`.
- A printer keeps an `hms` entry until it is cleared on its screen, so a finished or idle printer can still list one from the last job (an H2D showed `0500_0500_0001_0007` after finishing). Bambu Studio and Orca 2.4.2 keep the `hms` list on their HMS page and show only `print_error` on the task panel (`StatusPanel::update_error_message`). SlicerX treats an `hms` entry as current only while the job runs, is paused or is being prepared, and `print_error` also while the job failed. Anything else is marked `stale`: the card shows no error for it, and the printer's Controls and files page lists it muted, under "From an earlier job".

### Events and rate

Events are pushed. Status events are emitted when anything other than the timestamp changes. When the MQTT connection drops the printer reads as offline and reconnects every two seconds.

### Testing

`bambu_contract` in `tests/drivers.rs` runs the contract suite against a fake broker, FTPS server and camera (the mock generates a throwaway certificate with `openssl`). `tests/plug_and_play.rs` covers a connect without a serial, `printer_type`, the `file:///sdcard/` URL and the SD card check; `POST /bambu` on the control server takes `printerType`, `storage` and `emmc`. Mock credentials: access code `12345678`, serial `01S00C000000000`.

### Sources

Bambu Lab's LAN protocol is documented by the community: https://github.com/Doridian/OpenBambuAPI (`mqtt.md`, `ftp.md`, `video.md`). Bambu Studio (`DeviceManager.cpp`, `DevConfigUtil.h`, `DevStorage.cpp`, `SelectMachine.cpp`) for `printer_type`, the storage flags and the LAN send checks. ha-bambulab (`pybambu/const.py`) for the `project_file` URL per model.
