# Printer connect guide

Reference for SlicerX's network-first printer setup. It records how each printer family is found, how it authenticates, which fields it reports that setup can auto-fill, what goes wrong on first connect, and what to tell the user. Each claim comes from the research behind this guide. Claims from community sources, or that no source confirmed, are marked "community" or listed under "Unconfirmed". Nothing here has been verified on SlicerX hardware unless a line says so.

Paths in "Gaps in sx-connect" are relative to the repo root.

## 1. Summary

| Family | Discovery | Auth | User must enter | Main pitfall |
|---|---|---|---|---|
| Bambu Lab (A1, P1, X1, H2, P2S) | SSDP, UDP 1990 and 2021 | MQTT, FTPS and camera with user `bblp` and the 8 character access code | Access code (IP if SSDP is blocked) | Without Developer Mode the printer sends status but refuses commands, so prints go through Bambu Connect |
| Prusa (MK4, MK3.9, MK3.5, Core One, XL, MINI) | None confirmed. DHCP MAC prefix 109C70 or a probe of port 80 | HTTP Digest, user `maker`, password shown on printer | Password (IP if not found) | No known mDNS service. Storage name varies, driver hard-codes `usb` |
| Creality stock (K1 family, K2 family, Ender-3 V3, Hi) | mDNS `_Creality-<SN>._udp.local` (community), TCP 9999, `GET /info` | None | Nothing | Stock K1 and Ender-3 V3 KE have no usable Moonraker. K2 port 4408 is a web UI, not the API |
| Elegoo Centauri Carbon | UDP broadcast `M99999` to port 3000 | None | Nothing (IP if broadcast fails) | Few concurrent clients. Status codes conflict between sources |
| Elegoo Neptune 4 series | mDNS `_moonraker._tcp` if announced (unconfirmed) | Moonraker trusted clients or API key | IP, API key only on 401 | Old Moonraker on the Makerbase board. 401 from untrusted client |
| Snapmaker U1 | `U1.local` via zeroconf, then Moonraker probe | None by default, optional login on extended firmware | Nothing | Port 80 versus 7125. Login on extended firmware gives 401 |
| Snapmaker A150, A250, A350 | UDP broadcast `discover` to port 20054 | Token approved on the touchscreen | Tap Yes on printer | Idle sessions drop after 10 to 20 s. Token lost on power off |
| Snapmaker J1, J1S, Artisan | Same UDP 20054 | SACP on TCP 8888 with touchscreen token | Tap Yes on printer | Binary protocol, not implemented in SlicerX |
| Anycubic Kobra 3, S1, 4, X | No documented mechanism. Treat as IP entry | Signed HTTP handshake on 18910 yields MQTT credentials, MQTT over mutual TLS on 9883 | IP | LAN Mode permanently unpairs the printer from the Anycubic account |
| Qidi (X-Max 3, Plus 4, Q1 Pro, Q2, Max 4) | IP entry. mDNS unconfirmed | Moonraker trusted clients, API key, possible Fluidd login | IP | Fluidd is on port 10088, the API is on 7125 |
| Sovol SV08 | Moonraker on 7125 or `.local`. mDNS unconfirmed | LAN ranges trusted in factory config | IP | Custom older Klipper fork. 401 from VLAN or VPN |
| FLSUN V400 | Mainsail on port 80, Moonraker on 7125 | No documented login | IP | Delta bed is round. Own Klipper build |
| UltiMaker S-line, UM3 | mDNS `_ultimaker._tcp.local` | Cluster API without auth. Printer API uses Digest with touchscreen approval | Tap Allow on printer if the printer API is needed | Which endpoints need Digest on current firmware is not documented |
| Generic Klipper (Moonraker) | mDNS `_moonraker._tcp.local`, probe `GET :7125/server/info` | `trusted_clients`, `X-Api-Key`, JWT, one-shot token | API key only on 401 | Moonraker config changes need a restart. 7125 versus 80, 4408, 4409 |
| OctoPrint, Repetier-Server, Duet, Marlin USB serial | Not researched | Not researched | Not researched | Not researched |

On Windows, discovery that listens for announcements (SSDP, mDNS, UDP broadcast replies) needs Windows Firewall to allow the listening program inbound on private networks; closing the prompt Windows shows on the first scan leaves a Block rule. When a scan finds nothing, the desktop app reads the enabled inbound rules for its own program (`Get-NetFirewallApplicationFilter` and `Get-NetFirewallRule`, no admin rights, enum names that are not translated, unlike `netsh` output; apps/desktop/src-tauri/src/firewall.rs) and says whether the firewall blocks it, has no rule for it, or allows it. When it does not allow it, "Allow in Windows Firewall" opens Windows' own Allowed apps page; the app never adds a rule itself. A standalone sx-link is a separate program with its own rules and is not checked. Entering the IP address connects outward and works either way. OrcaSlicer, Bambu Studio and PrusaSlicer do not check.

## 2. Brands

### Bambu Lab

Models covered: A1 and A1 mini (model codes N2S and N1), P1P (C11) and P1S (C12), X1 (BL-P002), X1 Carbon (BL-P001), X1E (C13), P2S (N7), H2D (O1D), H2D Pro (O1E), H2S (O1S), H2C (O1C2 in Orca profiles, Studio also has O1C). A2L is N9 and is out of scope.

#### Discovery

- SSDP over UDP. The printer broadcasts NOTIFY about every 5 s from source port 1900, alternating destination ports 1990 and 2021 (community). It also answers an M-SEARCH with ST `urn:bambulab-com:device:3dprinter:1` by unicast.
- Headers: `Location` (IP), `USN` (serial), `DevModel.bambu.com` (model code), `DevName.bambu.com`, `DevConnect.bambu.com` (`lan` or `cloud`), `DevBind.bambu.com` (`free` or `occupied`), `DevSignal`, `DevVersion`, `DevInf`, `Devseclink`, `DevCap`. A real H2D answer recorded by SlicerX adds `DevSeclink: secure`, `DevInf: wlan0`, `DevCap: 1`.
- Ports: MQTT TLS 8883, FTPS implicit TLS 990. Camera: A1 and P1 use a TLS stream on TCP 6000. X1, X1E, P2S and H2 use RTSPS on 322 (`rtsps://IP:322/streaming/live/1`, user `bblp`, password the access code). Port 6000 is not the camera on X1.
- The printer leaf certificate CN is the serial number, so the serial can be read from the TLS handshake on 8883 (needs SNI) even when SSDP is blocked (community, OpenBambuAPI tls.md).
- A printer in cloud mode still announces over SSDP.
- Guest Wi-Fi and VLANs block UDP broadcast. Offer manual IP entry and an SSDP unicast probe.

#### Auth

- MQTT: user `bblp`, password the 8 character LAN access code. Topics `device/{serial}/report` and `device/{serial}/request`. FTPS: user `bblp`, same code. Camera on 6000: TLS, then an 80 byte packet (u32 LE 0x40, 0x3000, 0, 0, a 32 byte user, a 32 byte code).
- Official (third-party integration page): MQTT status pushes, starting prints from an SD card and SD card firmware updates are not affected by Authorization Control. Printing from other software without Developer Mode goes through Bambu Connect, whose URL scheme is `bambu-connect://import-file?path=...&name=...&version=1.0.0` (Bambu Connect wiki page, "Launching Bambu Connect from Third-Party Software"). Bambu Connect runs on Windows 10 or later and macOS 13 or later; Linux is "under development".
- Official: firmware with Authorization Control blocks write commands from third parties in cloud mode and in normal LAN mode. Developer Mode, under LAN Only Mode, restores open MQTT, FTP and video with no authorization, LAN only. Read-only MQTT status is unaffected.
- Firmware floors for Authorization Control: A series 01.05.00.00, P1 01.08.02.00, X1 01.08.03.00 (official third-party page plus secondary sources). H2D Developer Mode from 01.01.00.01 and P2S from launch come from SimplyPrint only.
- Earlier P1 firmware around 01.07.00.00 had a hybrid restriction: a cloud-connected printer used locally allowed only light control (community, ha-bambulab docs).
- Official wiki: starting a print in LAN mode on X1 requires a micro SD card.
- A MQTT CONNACK refusal means a wrong access code.

#### Fields reported for auto-fill

- `get_version` (`info.module[]`): `project_name` (N2S, N1 on A1; empty on X1), `hw_ver` (AP05, AP04, AP07, AP02 on X1E), `sw_ver` from the ota module, `sn`, `product_name` on newer firmware (for example "Bambu Lab P1S", "Bambu Lab H2D", "Bambu Lab P2S"). A1 mini firmware reuses `hw_ver` for different models, and P1P and P1S both report AP04, so identify by `project_name` or `product_name`. X1 and X1C both report AP05; only SSDP `DevModel` separates BL-P001 and BL-P002.
- `pushall` `print.*`: `nozzle_diameter`, `nozzle_type`, `ams` (`ams[].id`, `tray[]` with `tray_type`, `tray_color` as RRGGBBAA, `tray_sub_brands`, `remain`, `tag_uid`), `ams_exist_bits`, `vt_tray` (external spool, id 254), `ipcam.ipcam_dev`, `ipcam.ipcam_record`, `ipcam.resolution`, `sdcard` (bool), `wifi_signal`, `lights_report`, `gcode_state`, `hms`, `home_flag`, `spd_lvl`, `print.printer_type` (Bambu Studio parses it). X1 adds `chamber_temper`, `ipcam.rtsp_url`, `ipcam.liveview.local`, `xcam`.
- Bambu Studio also reads `ipcam.liveview.local` (none, disabled, local, rtsps, rtsp), `ipcam.file.local` and `ipcam.rtsp_url` (official source, DeviceManager.cpp). H2 reports `rtsp_url` as `disable` until LAN liveview is on.
- `fun`: bit 0x20000000 set means MQTT signing is required, so Developer Mode is off (community, ha-bambulab). Seen values 3EC1AFFF9CFF and 3EC18FFF9CFF.
- H2D: `device.extruder.info[]` (temperature packed, low 16 bits current and high 16 bits target, community), per-extruder nozzle diameter and type, `ams[]` including AMS HT (ids 128 to 135, community), `vt_tray` ids 254 and 255, `ams_mapping2`.
- Not reported: bed size and kinematics.
- From SSDP: IP, serial, model code, name, firmware (`DevVersion`), LAN versus cloud, bound versus free.
- From the cloud device list (see Cloud below): serial, name, model, access code, nozzle size, online.

#### First-connect pitfalls

- LAN Only Mode must be on to read the access code. The code can show as all zeros until LAN Only is toggled off and on, and a power cycle is advised after the first enable (SimplyPrint, secondary).
- The Developer Mode toggle appears only after LAN Only is on, and only on firmware that has it.
- A cloud-mode printer accepts the code but refuses commands. If it was on cloud mode when Authorization Control firmware arrived, writes silently fail until LAN Only and Developer Mode are on. SlicerX treats such a printer as monitor-only and sends prints through Bambu Connect.
- P1 and A1 hardware is slow. Do not repeat `pushall` (OpenBambuAPI: not more often than every 5 min on P1P). P1 and A1 `push_status` reports are deltas, so merge them. X1 `pushall` is always a full object.
- X1 without an SD card: a new job from a slicer fails (official wiki).
- H2 LAN RTSPS is off by default. Port 322 closes at once until "LAN Only Liveview" is on (community, OpenBambuAPI video.md).
- P2S firmware 01.02.00.00 reportedly never answers a TLS 1.3 ClientHello. ha-bambulab caps TLS at 1.2 (community).
- Two certificate chains exist across firmware. Do not pin a single CA. Known issuers from ha-bambulab's bundled certs: BBL CA (2022 to 2032, root), BBL CA2 RSA and BBL CA2 ECC (2025, valid to 2035, each as a self-signed root and a version cross-signed by BBL CA), and device CAs BBL Device CA N7-V2 (P2S), O1C2-V2 (H2C) and N6-V2 (X2D), each issued by BBL CA2 RSA.
- FTPS: implicit TLS on 990, user `bblp`, access code, passive data ports. Community says root plus cache directories, and `ftp:///` as the `project_file` URL. ha-bambulab uses `file:///sdcard/` for X1, X1C, X1E, P1P, P1S, A1 and A1 mini and `ftp:///` for newer models; OpenBambuAPI shows both.
- Cloud sign-in alternative (community only, not an official API): `POST /v1/user-service/user/login` (password or emailed code, TFA possible, Cloudflare can block), then `GET https://api.bambulab.com/v1/iot-service/api/user/bind` with `Authorization: Bearer`. China region is `api.bambulab.cn`. The response `devices[]` has `dev_id` (serial), `name`, `online`, `print_status`, `dev_model_name`, `dev_product_name`, `dev_access_code`, and from 2026 `print_job`, `nozzle_diameter`, `dev_structure`.

#### What to show the user

Offer a scan, then one field (the access code) plus a model-specific screen hint. The access code is enough for status; suggest LAN Only Mode only when the printer can't be reached. Developer Mode is optional, under "Direct printing": without it, prints go through Bambu Connect. Signing in to a Bambu account is out (owner decision, 2026-10-05): Bambu Lab's terms forbid it, and cloud print commands need Bambu's signing anyway. State plainly that LAN Only plus Developer Mode disables cloud features and that the Bambu Handy app and cloud printing stop. Menu paths per the official wiki:

- A1 and A1 mini: Settings, scroll to page 3, LAN Only Mode, turn on (the button turns green). The access code is on that screen and the IP is on the WLAN screen. Then turn on Developer Mode on the same screen.
- P1P and P1S: Settings, WLAN, LAN Only Mode (initially off), confirm Yes, note the Access Code. Developer Mode is a separate toggle in that menu on 01.08.02.00 or newer.
- X1, X1 Carbon, X1E: Settings, LAN Only (the page is named "LAN Only"), turn it on, optionally enable LAN mode liveview, then the Developer Mode toggle. Access code and IP are on that screen. Remind the user a micro SD card is needed for printing.
- P2S, H2D, H2D Pro, H2S, H2C: Settings, LAN Only (not "Network"), turn on LAN Only, enable "LAN Only Liveview" if the camera is wanted, then Developer Mode. Access code and IP are on that page. Official wiki: Developer Mode applies to 3D printing control only and lets third-party software manage print jobs and process data.

### Prusa (MK4, MK4S, MK3.9, MK3.5, Core One, XL, MINI)

All run Buddy firmware with built-in PrusaLink. Home Assistant docs: modern models need firmware 4.7.0 or newer, MINI needs 5.1.0 or newer. Older Pi-based MK2.5 and MK3 use the separate Prusa-Link package and are out of scope.

#### Discovery

- No confirmed mDNS service type. Prusa docs and the Home Assistant PrusaLink integration name none. Home Assistant uses DHCP discovery on the Prusa MAC prefix 109C70 and has no zeroconf entry in its manifest. Buddy issue 3809 (March 2024) says hostname and mDNS addressing is not available on MK4.
- Practical methods: a DHCP MAC prefix match, or a subnet probe of TCP 80 with `GET /api/version`. The probe needs auth on many firmware versions.
- The printer shows its IP at Settings, Network, IPv4 Address.

#### Auth

- The official OpenAPI spec declares only HTTP Digest (`digestAuth`) for every endpoint. The username is fixed as `maker`. The password is a random 15 character alphanumeric string shown on the printer.
- The Prusa forum and Home Assistant docs say the API key was deprecated in 5.x firmware and the field may still be labeled "API key" but is used as the Digest password. Some sources say `X-Api-Key` works without Digest on some versions (certainly on Pi PrusaLink 0.7.x). Whether Buddy 5.x accepts it is unconfirmed.
- The 5.1 upgrade reportedly invalidated old logins.

#### Fields reported for auto-fill

- `GET /api/version`: `api`, `version`, `printer`, `text` (for example "PrusaLink 0.7.0"), `firmware` (for example "3.10.1-4697"), `sdk`, `capabilities.upload-by-put`. Home Assistant also reads `server`, `original`, `hostname`.
- `GET /api/v1/info` (spec): `mmu` (bool), `name`, `location`, `farm_mode`, `nozzle_diameter`, `min_extrusion_temp`, `serial`, `sd_ready`, `active_camera`, `hostname`, `port`, `network_error_chime`. The spec Info schema has no model field.
- `GET /api/v1/status`: `printer.state` (IDLE, BUSY, PRINTING, PAUSED, FINISHED, STOPPED, ERROR, ATTENTION, READY), `temp_nozzle`, `target_nozzle`, `temp_bed`, `target_bed`, axes, flow, speed, fans, `job` (id, progress, time_remaining, time_printing), `transfer`, `storage`, `camera`.
- `GET /api/v1/storage`: name, type (LOCAL, SDCARD, USB), path, free_space, total_space, available, read_only. `GET /api/v1/cameras` lists cameras.
- Loaded material per tool is not exposed (Buddy issue 4811, closed as not planned).

#### First-connect pitfalls

- The user must read credentials on the printer, and PrusaLink may need enabling there.
- A 401 on the first request is normal (Digest challenge). The algorithm must be MD5 per RFC 7616.
- Upload: `PUT /api/v1/files/{storage}/{path}` with `Overwrite` and `Print-After-Upload` headers (RFC 8941 booleans `?0` and `?1`). 201 on success, 409 if the file is printing or storage is busy or unavailable. Spec examples use `/local`; Buddy uses `usb`. Take names from `/api/v1/storage`.
- Start: `POST /api/v1/files/{storage}/{path}` returns 204, or 409 if a job is running. Pause, resume and stop: `PUT /api/v1/job/{id}/pause`, `PUT /api/v1/job/{id}/resume`, `DELETE /api/v1/job/{id}`.
- Wi-Fi is 2.4 GHz only (802.11 b/g/n). DHCP addresses change, so store the hostname or serial too.
- Prusa Connect (cloud) is separate. Registration code is at Settings, Network, Prusa Connect, Add printer. No public cloud API spec was found, so local PrusaLink is the supported path.

#### What to show the user

Step 1: after a scan or IP entry, show name or hostname, firmware, serial, nozzle diameter, MMU yes or no, camera yes or no and the storage list. Step 2, the only thing asked: "On the printer, open Settings > Network > PrusaLink and enter the password shown (username is maker)." Do not ask for an IP when discovery found one. Distinguish a wrong password (401) from unreachable in the error text. If `/api/v1/storage` reports no available USB storage, tell the user a USB drive is needed. Offer Prusa Connect only as optional cloud.

### Creality

Models covered: K1, K1C, K1 Max (K1 family), K2 Plus (board F008), K2 Pro (F012), K2 (F021), Ender-3 V3 (F001), V3 Plus (F002), V3 KE (F005), Creality Hi (F018).

#### Discovery

- Stock Creality Print path: mDNS service `_Creality-<SN>._udp.local` advertised by `/usr/bin/mdns` on K1 and K1C (community, not official). The printer keeps advertising when its HTTP backend is dead, so an mDNS hit does not prove reachability.
- K2 does not resolve by mDNS hostname, so use the IP. OrcaSlicer Browse finds K2 via mDNS and identifies it by model code (F008, F012, F021), but the service type and TXT keys were not confirmed.
- Rooted or Moonraker printers may advertise `_moonraker._tcp`.
- Probe fallback: TCP 9999, `GET http://ip/info` (JSON with `model`), `GET :7125/server/info`.

#### Auth

- Native 9999 WebSocket and port 80 `/info` and `/upload`: no password, pairing or token on stock firmware. OrcaSlicer's host sends an optional `Authorization: Bearer <apikey>` header, but stock printers do not require it.
- Moonraker has no auth by default (trusted clients), and returns 401 or 403 only if configured.
- SSH root is needed only for community mods. Enable at the touchscreen: Settings, "Root account information", accept the disclaimer (K2: wait 30 s, press Ok). Default passwords vary by firmware: `creality_2023` (K1 family), `creality_2024` (K2), and `creality` in older rooted-firmware docs.

#### Fields reported for auto-fill

- WebSocket 9999 (JSON push): `model`, `modelVersion` (carries the board code such as F008), `hostname`, `mac`, `version` (firmware), `nozzleTemp`, `targetNozzleTemp`, `bedTemp0`, `targetBedTemp0`, `boxTemp`, `targetBoxTemp` (K1 family read-only, K2 controllable, Ender and Hi none), `state`, `err.errcode`, `withSelfTest`, `printFileName`, `printProgress`, `dProgress`, `layer`, `TotalLayer`, `printLeftTime`, `curPosition`, `webrtcSupport` (K1 firmware 1.3.5.22 and later), light and fan states, CFS slot data on K1C, K2 and Hi.
- `GET http://ip/info`: JSON including `model`. OrcaSlicer uses it to pick K1-family or K2-family behavior (K1 family data root `/usr/data`, K2 family `/mnt/UDISK`). Orca lists model codes K1, K1 SE, K1C, K1_CFS-C, F008, F012, F021.
- Moonraker (rooted K1 and Ender, stock K2): `printer.info`, `machine.system_info`, `server.info` give hostname, Klipper version and, via `configfile`, build volume.

#### First-connect pitfalls

- Stock K1, K1C, K1 Max and Ender-3 V3 KE ship Klipper, but Moonraker, Fluidd and Mainsail are not set up and not reachable. Moonraker is present but disabled and outdated (community). Fluidd on 4408, Mainsail on 4409 and Moonraker on 7125 need root plus the Guilouz Creality Helper Script (K1 firmware 1.3.3.5 or newer, KE firmware 1.1.0.12 or newer).
- K2 family: Moonraker on 7125 plus an nginx proxy to Fluidd on 4408 are stock. The K2 Moonraker config sits outside the file API. Ports 80 and 443 redirect to Fluidd on 4408. 9999 is still served.
- A discovered K2 URL ending `:4408` must not be used as the REST API host. `/info` on 4408 returns Fluidd or Mainsail HTML, not JSON (OrcaSlicer PR 15900).
- Replacing the stock web server, master server or app server (for example installing HelixScreen) kills port 80, so Creality Print LAN, AI failure detection and Creality Cloud stop working.
- K1 firmware 1.3.5.22 moved the camera from MJPEG on 8080 to WebRTC on 8000 (`webrtcSupport: 1`). K2 is WebRTC only.
- The K1-family WebSocket is strict: text frames only, and the printer sends `{"ModeCode":"heart_beat"}`, which must be answered with the text `ok` (Orca source).
- Telemetry arrives as delta frames, and numbers can be strings.
- The file list reply (`retGcodeFileInfo2`) is about 150 KiB per 200 files. Set a large max frame size (ha_creality_ws raised it to 16 MiB for more than 1300 files).
- Creality Cloud runs over the printer's own MQTT link, separate from the LAN 9999 WebSocket. LAN control does not need a Creality Cloud account.

#### What to show the user

"Found a Creality printer at <ip>." Show the model name (from `/info` or telemetry, with the board code mapped to a friendly name), hostname, firmware version, MAC, nozzle, bed and box temperatures, and camera type (MJPEG or WebRTC). No code or password is needed. If only 9999 answers: "Stock firmware, status, upload and print control available, no Moonraker." For an unrooted K1 or Ender-3 V3 KE, do not ask for an API key. Offer the optional "Enable root" path (Settings > Root account information) only for Moonraker and Fluidd. For K2 say "Camera not available (WebRTC)". Warn that Creality Print or another client may be holding the connection.

### Elegoo

#### Centauri Carbon (SDCP V3.0.0)

Firmware V1.0.0 in public captures. Mainboard from the cbd-tech and ChituBox lineage.

Discovery:
- Send the ASCII string `M99999` by UDP broadcast to port 3000. Each printer unicasts JSON: `{Id, Data:{Name, MachineName, BrandName, MainboardIP, MainboardID (16 hex chars), ProtocolVersion, FirmwareVersion}}`.
- Then WebSocket `ws://IP:3030/websocket` with envelope `{Id, Data:{Cmd, Data, RequestID, MainboardID, TimeStamp, From}, Topic:sdcp/request/<MainboardID>}`. Replies come on `sdcp/response/`, pushes on `sdcp/status/`, `sdcp/attributes/`, `sdcp/error/`, `sdcp/notice/`. No mDNS is documented.
- The IP is under Settings > Network on the touchscreen (per SlicerX docs, not confirmed by Elegoo).

Auth: none. No token, access code or password. Anyone on the LAN can control the printer. Cmd 1 reports a cloud service count (`MaximumCloudSDCPSercicesAllowed` 1, `NumberOfCloudSDCPServicesConnected`) but no LAN lock or pairing is documented.

Fields for auto-fill:
- Discovery reply: `Name`, `MachineName` (model), `BrandName`, `MainboardIP`, `MainboardID` (serial-like), `FirmwareVersion`, `ProtocolVersion`.
- Cmd 1 (attributes): `XYZsize` (for example 300x300x400), `CameraStatus`, `Capabilities` (FILE_TRANSFER, PRINT_CONTROL, VIDEO_STREAM), `NetworkStatus` (wlan or eth), `MaximumVideoStreamAllowed`, `NumberOfVideoStreamConnected`, `DevicesStatus`.
- Status push: `CurrentStatus[]`, `TimeLapseStatus`, `PlatFormType`, `TempOfNozzle`, `TempTargetNozzle`, `TempOfHotbed`, `TempTargetHotbed`, `TempOfBox`, `TempTargetBox`, `CurrenCoord`, `CurrentFanSpeed{ModelFan, AuxiliaryFan, BoxFan}`, `ZOffset`, `LightStatus{SecondLight, RgbLight}`, `PrintInfo{Status, CurrentLayer, TotalLayer, CurrentTicks, TotalTicks, Filename, TaskId, PrintSpeedPct, Progress}`.
- Nozzle diameter and type are not documented as reported.

Pitfalls:
- Idle sockets close after 60 s, so send a ping or any command regularly.
- Field names carry intentional typos that must be matched exactly (`CurrenCoord`, `RelaseFilmState`, `MaximumCloudSDCPSercicesAllowed`).
- Video and cloud connections are capped (Cmd 386 acks 1 when exceeded). The printer reportedly serves few concurrent clients, so close ElegooSlicer and the phone app first.
- Upload errors: -1 offset invalid, -2 offset mismatch, -3 file open failed, -4 unknown. Upload form: `POST http://IP:3030/uploadFile/upload` multipart with `Check=1`, `S-File-MD5`, `Offset`, `Uuid`, `TotalSize`, `File`, in 1 MB chunks.
- Start: Cmd 128 with `{Filename:/local/name.gcode, StartLayer:0, Calibration_switch, PrintPlatformType:0, Tlp_Switch}`. Ack codes: 0 ok, 1 busy or failure, 2 file not found, 3 MD5 failed, 4 file I/O failed, 5 resolution mismatch, 6 unknown format, 7 unknown model. Other commands: 129 pause, 130 stop, 131 resume, 258 file list, 320 history, 386 video (MJPEG on 3031), 387 timelapse, 403 speed, fans and light.
- Connections fail across VLANs and subnets and under client isolation. Broadcast discovery can fail while direct IP works. DHCP changes break saved IPs. There are reports of uploads failing on Linux in ElegooSlicer.

What to show: "Found: Centauri Carbon <Name> at <IP>, firmware, wired or Wi-Fi." No credential prompt. If a scan finds nothing, show "Enter IP" with the touchscreen path, plus a hint to close other apps (ElegooSlicer, phone app) and to check for the same subnet and no guest Wi-Fi. Offer Calibration and Timelapse toggles at start time.

#### Neptune 4, 4 Pro, 4 Plus, 4 Max

Klipper and Moonraker on a Makerbase MKS board. See also "Generic Klipper".

- Discovery: Moonraker announces `_moonraker._tcp` if its zeroconf component is active (not confirmed for Elegoo's shipped Moonraker). Otherwise the user enters the IP, read from the touchscreen "Advance Settings" (Obico guide) or the router. Probe `GET http://IP:7125/server/info` and `/printer/info`. Web UI is Fluidd on 80 or 4408, or Mainsail on 4409, on community images.
- Auth: Moonraker `[authorization]`. A client outside `trusted_clients` gets 401 unless it sends `X-Api-Key` or a one-shot or JWT token. Elegoo's shipped config reportedly trusts the LAN, unconfirmed. SSH default is `mks` / `makerbase` (community), config at `/home/mks/klipper_config/moonraker.conf`.
- Auto-fill: `/server/info`, `/printer/info` (hostname, software_version), `/machine/system_info`, `configfile` (stepper bounds, nozzle_diameter, max_velocity), `extruder`, `heater_bed`, `print_stats`, `virtual_sdcard`, `/server/webcams/list`.
- Pitfalls: the shipped Moonraker is old and hard to update (community), so newer endpoints such as the webcam list and announcements may be missing. Upload is multipart `POST /server/files/upload` (root `gcodes`). Start is `POST /printer/print/start?filename=`. 401 when the client IP is not trusted. 503 or `klippy_state` not ready after power-up. A stale DHCP IP is the common failure. The webcam URL in config must be the printer's own address, not 127.0.0.1.
- What to show: "Found: Neptune 4 (Klipper) at <IP>." On 401 show the two fixes (add the LAN to `trusted_clients` and restart Moonraker, or paste the API key). Otherwise no prompt.

### Snapmaker

#### U1 (4-toolhead Klipper toolchanger)

- Discovery: the Moonraker fork (Snapmaker/u1-moonraker) ships `[zeroconf]` with `mdns_hostname U1`, so the host resolves as `U1.local` (per u1-companion notes). The DNS-SD service type is not documented. No UDP 20054 broadcast. Web UI on `http://<ip>/` (nginx, port 80). Moonraker native port 7125. Touchscreen Settings > Network (or LAN) shows the IP. Confirm identity with `GET /server/info` and the presence of the `print_task_config` Klipper object (u1-companion uses it to reject generic Klipper).
- Auth: none by default, LAN clients are trusted. Optional "Require Login" (Fluidd only) in the community extended firmware turns on Moonraker login (admin password, recover with `extended-recover.txt` on USB). Advanced Mode (Settings > Maintenance > Advanced Mode) is needed to reach `/firmware-config/`.
- Auto-fill: standard Moonraker (`/server/info`, `/printer/info`, `/machine/system_info`, `/printer/objects/query`) plus `print_task_config` (4 slots with material metadata, a logical-to-physical color map up to 32 colors to 4 heads, auto-replenish and entangle-detection flags), filament detect RFID data (tag date, SKU, spool weight, recommended temperatures, official verification flag, scan state), the machine state manager (integer enum plus action code) and `filament_color_rgba` per slot. Per-color usage is not live; use `/server/files/metadata`. Cameras: `/server/webcam/list`; internal RTSP `rtsp://<ip>:8554/stream`, USB camera `rtsp://<ip>:8555/stream`, `http://<ip>/webcam2/` (extended firmware only).
- Pitfalls: both 80 and 7125 work on stock, so use 80 first and fall back to 7125. Extended firmware "Require Login" makes `/server/info` return 401 until a token or API key is given. The Prometheus exporter on 9101 and the RTSP ports exist only on custom firmware. No official Snapmaker network API documentation was found. Behavior comes from the open u1-moonraker repo and community projects.
- What to show: "Found U1 at <ip> (hostname U1), Klipper ready, 4 toolheads with loaded filament and colors." Ask nothing unless login is required, then ask for the API key or login.

#### A150, A250, A350 (Snapmaker 2.0, Luban HTTP API)

- Discovery: send ASCII `discover` by UDP broadcast to port 20054, 1 s timeout, retry up to 5 times, wait 5 to 10 s in total. The reply is pipe-delimited, for example `A350-3DP@192.168.1.100|model:A350|status:IDLE`. Exact keys are not officially documented (the CuraSnapmakerSender example `Snapmaker@192.168.1.100|token:abc123|model:A350` is community). The IP can also be taken from the UDP source. No mDNS. Windows firewall and routers that block UDP broadcast defeat it, so keep direct IP entry.
- Auth: `POST http://<ip>:8080/api/v1/connect` with form field `token` (empty on first pairing, or a saved token). The reply includes `token`, `series`, `headType`, `data`. The printer shows an approval prompt on the touchscreen. The client polls `GET /api/v1/status?token=`: 204 waiting, 200 approved, 401 rejected. The approval window is about 60 s. Tokens are lost on power off. `POST /api/v1/disconnect` clears a pending prompt. Luban sends the token in the body for POSTs and in the query for GET status. Newer notes (nozzle-it-all) say body only.
- Auto-fill: connect reply `series` (for example A350), `headType` (1 print, 2 CNC, 3 laser L1, 4 laser L2, 5 dual printing, 6 L20W laser, 7 L40W laser, 8 200W CNC, 9 L2W laser), `data`. Status fields: `status`, `homed`, `x`, `y`, `z`, `b`, offsets, `currentLine`, `totalLines`, `estimatedTime`, `elapsedTime`, `remainingTime`, `fileName`, `progress`, `printStatus`, `nozzleTemperature`, `nozzleTargetTemperature` (dual head suffix 1 and 2 per SlicerX, unverified), `heatedBedTemperature`, `heatedBedTargetTemperature`, `isEnclosureDoorOpen`, `isFilamentOut`, `airPurifierSwitch`, `moduleList`. Other endpoints: `module_list`, `module_info`, `active_extruder`, `enclosure`. Firmware version and serial are not in these replies.
- Pitfalls: idle HTTP sessions drop after 10 to 20 s on the A350 and return 401, so reconnect with the saved token and treat as transient (ifnull/homeassistant-snapmaker PR 1). A persistent 403 for about 5 minutes means the token is invalid. Never pair from a polling loop, because each attempt raises a touchscreen prompt. Wi-Fi on the A350 is flaky, so power off for 15 s before retrying. `prepare_print` loads the file on screen (only the last file is startable). `/api/v1/upload` (`file`, `filename`) also exists. Refuse laser and CNC heads. The newest A-series firmware reportedly may have removed HTTP in favor of SACP (forum report, version not identified).
- What to show: "Found A350 at <ip>, 3D printing head (single or dual from `headType`)." Tell the user to look at the touchscreen and tap Yes within 60 s. Show a countdown and a retry button, and explain that the token resets when the machine is powered off.

#### J1, J1S, Artisan (SACP on TCP 8888)

- Discovery: the same UDP 20054 `discover` broadcast. Replies carry names such as `J1V19` or `Snapmaker-J1` (sm2uploader). Port 8080 is closed on the J1S (3D Etplus testing). No mDNS known.
- Auth: SACP handshake on TCP 8888 with a token confirmed on the touchscreen (tap Yes). The token is lost on power cycle. Packet spec: github.com/Snapmaker/Snapmaker-SACP. Forum users say token acquisition is under-documented. nozzle-it-all PR 46 claims byte-exact SACP vectors from SACP SDK 0.1.1 (ISC license).
- Auto-fill through SACP: extruder temperatures (CommandSet 0x10, int32 little-endian millidegrees C, per nozzle via a HeadID byte for left T0 and right T1), heated bed (CommandSet 0x14), subscription feeds for print status and coordinates, filename and line count from the controller (peer ID 1) and screen MCU (peer ID 2). Model, serial and firmware command IDs are not confirmed.
- Pitfalls: binary protocol with two peers on one connection. Machine type identification and state mappings were flagged as needing hardware verification. Remote print start is gated and unverified in nozzle-it-all. Refuse laser and CNC heads on Artisan. Artisan firmware 2.x may expose only SACP.
- What to show: "Found J1 or Artisan at <ip>." Say it needs touchscreen approval. Until SACP is built, offer G-code export.

### Anycubic (Kobra 3, 3 Combo, 3 V2, 3 Max, S1, S1 Max, Kobra 4, Kobra X)

Model IDs: Kobra 3 and 3 Combo 20024, 3 V2 20027, 3 Max 20026, S1 20025, S1 Max 20029, Kobra 4 20028, Kobra X 20030, with ACE Pro or ACE 2. The Kobra 2 family (20021 to 20023) is experimental only (unsigned handshake). All of this is community knowledge. No official Anycubic LAN API document was found.

- Discovery: no official docs. Community says the printer serves local MQTT only while LAN Mode is on (Settings > Network > LAN Mode). hass-anycubic says LAN-mode printers broadcast themselves, without naming the mechanism. A hass-anycubic-next PR mentions DHCP matchers. anycubic-lan docs say no auto-discovery, IP only. Anycubic Slicer Next has its own discovery that users report failing (AnycubicSlicer issue 23). Treat as manual IP entry, optionally with a DHCP or MAC prefix hint.
- Auth: a two-step handshake with no user-typed credential. (1) `GET http://PRINTER:18910/info` (metadata including `modelId`). (2) A signed `POST` to `/ctrl`, whose response carries AES-encrypted MQTT broker credentials. (3) MQTT over mutual TLS to `PRINTER:9883`. Credentials rotate on printer restart and are held in memory only, so rerun the handshake on failure. Cloud mode instead uses an AWS IoT broker (`a1mqttxrcwtdv-ats.iot.us-east-1.amazonaws.com:7125` per kobra-connect) with Anycubic account credentials.
- Auto-fill (MQTT): `modelId` (from `/info`), firmware version, state, nozzle and bed temperatures (`target_nozzle_temp`, `target_hotbed_temp`), fans, `print_speed_mode` (1 silent, 2 standard, 3 fast), job progress, layers, times, filename, task ID, lights (type 1 head, 2 chamber, 3 camera), head position, capability flags, last error code, camera URL (RTSP session on Kobra X; HTTP stream typically port 18088), ACE boxes and slots (material, color, humidity, temperature, drying state, auto-feed). Topics: `anycubic/anycubicCloud/v1/slicer/printer/{model_id}/{device_id}/{endpoint}` for commands and `anycubic/anycubicCloud/v1/printer/public/{model_id}/{device_id}/{endpoint}/report` for replies. Envelope: `type`, `action`, `timestamp` (ms), `msgid` (uuid4), `data`. Build volume, nozzle size and bed are not reported, so keep them from the catalog by `modelId`.
- Pitfalls:
  1. Turning LAN Mode on removes the printer from the Anycubic cloud account permanently. Turning it off does not re-pair it. The user must re-pair in the Anycubic app. Warn before they flip it.
  2. The printer may fall back to cloud mode. The user must re-enable LAN Mode.
  3. Guest Wi-Fi and client isolation block it.
  4. ACE answers only on request. Poll about every 30 s. A newly idle ACE shows nothing until the next poll.
  5. Temperature and fan changes are ignored while the printer is idle.
  6. The chamber LED turns on automatically when camera capture starts.
  7. LAN telemetry is polled about every 15 s.
  8. File upload and browse are not available in LAN mode in the Home Assistant integrations. kobra-connect documents HTTP upload at `http://PRINTER:18910/gcode_upload?s={token}` (token source unconfirmed).
  9. The protocol is undocumented and firmware updates can break it.
  10. Stock firmware is not Klipper. Moonraker exists on the Kobra 3 only with the Rinkhals root mod.
- What to show: a step card: "On the printer open Settings > Network > LAN Mode and turn it on. This disconnects the printer from your Anycubic account for good." Then ask only for the IP (on the printer's network screen). After the handshake, show the model, firmware and ACE slot colors. Show a clear "LAN Mode is off or the printer fell back to cloud" state.

### Qidi (X-Max 3, X-Plus 3, X-Smart 3, Plus 4, Q1 Pro, Q2, Max 4)

Stock firmware is a QIDI fork of Klipper plus Moonraker plus Fluidd. Q2 and Max 4 are per HelixScreen.

- Discovery: manual IP from the touchscreen network settings or the router. mDNS `_moonraker._tcp` on stock firmware is not confirmed. The Fluidd web UI is `http://IP:10088` (Qidi's X-Max 3 repo says the default port is changed to 10088). The Moonraker API is on 7125 (HelixScreen and Obico guides). Obico lists the config at `/home/mks/klipper_config/moonraker.conf`.
- Auth: standard Moonraker (trusted clients, `X-Api-Key`, JWT). Stock firmware recently added a Fluidd account management module (Q1 Pro README), so a login may be forced on newer firmware. The stock `trusted_clients` list was not confirmed. SSH is `mks` / `makerbase` on port 22 (Obico guide, for the Plus 4). QIDI Link is a separate cloud service.
- Auto-fill: standard Moonraker (`/server/info`, `/printer/info`, `/machine/system_info`, `/printer/objects/query` with `print_stats`, `extruder`, `heater_bed`, a chamber heater object, and `configfile` for `nozzle_diameter` and stepper bounds). Qidi markers: `box_stepper slot<N>` (QIDI Box), macros `M141`, `M191`, `CLEAR_NOZZLE`, a chamber heater, an RP2040 toolhead MCU. QIDI Box slot data comes through those objects, not the standard `mmu` object. The model name is not given directly. Infer it from config (printer.cfg path, bed size).
- Pitfalls: do not send users to 10088 for the API, since that is the Fluidd UI. On Q2 and Max 4 the QIDI Moonraker fork returns 404 for `/server/files/metadata` on every file (a whitelist drops thumbnails), so read thumbnails from the G-code header. Disabling `qidi-client` breaks the QIDI MQTT and cloud link and filament state. A forced login on new firmware is possible but unconfirmed. Community stacks (FreeDi, FreeQIDI) change the host but keep 7125.
- What to show: after a scan or IP entry, "Fluidd found" with a model guess, the nozzle sizes from `configfile`, the chamber heater and any QIDI Box slots. Ask for an API key or login only on 401 or 403. Hint: "The Fluidd page is at port 10088; SlicerX uses port 7125 behind it."

### Sovol (SV08, SV08 Max)

Stock firmware is Klipper with Moonraker and Fluidd. SV04 is Marlin behind OctoPrint and is already in the catalog as OctoPrint.

- Discovery: Moonraker on `0.0.0.0:7125` (factory-modified `moonraker.conf`, Klippy socket `/home/sovol/printer_data/comms/klippy.sock`). In a browser: `http://yourprinter.local:7125` (SimplyPrint guide) or the Fluidd page on port 80. mDNS `_moonraker._tcp` on stock firmware is not confirmed.
- Auth: the factory `moonraker.conf` lists `trusted_clients` 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 172.17.0.0/16, 192.168.0.0/16, FE80::/10 and ::1/128, so any LAN client works without a key. CORS includes `.local`, `.lan`, `my.mainsail.xyz`, `app.fluidd.xyz`. OctoPrint compatibility is on. This list comes from a community-posted config, not a Sovol document.
- Auto-fill: `server/info`, `printer/info`, `configfile` (`nozzle_diameter`, bed bounds, probe), `extruder`, `heater_bed`, chamber temperature if fitted, webcam list, history. The model is not reported. The Linux hostname or user (`sovol`) is a hint only.
- Pitfalls: SimplyPrint warns some vendors remove version info, and not all printers handle a Moonraker update (some integrations need v0.8.0 or newer). Sovol's Klipper is a custom older fork, so objects may differ from mainline. A user on a non-LAN range (VLAN, VPN) outside `trusted_clients` gets 401.
- What to show: fill the IP and port 7125. Show "connected, Klipper X, bed 350 x 350 x 345, nozzle 0.4" read from the printer. Ask for nothing else on a normal home LAN.

### FLSUN (V400)

Klipper on the stock Speeder Pad or an MKS Robin Nano V2 board plus Pad. Whether the S1 runs Klipper at all is not confirmed. Super Racer and T1 appear only in third-party guides.

- Discovery: Mainsail at `http://PRINTER_IP` (port 80), Moonraker on 7125 (FLSUN V400 config repos). `mainsail.local` or `fluidd.local` may work (SimplyPrint generic guide). The IP is on the Pad's network screen.
- Auth: no documented login. Moonraker's default trusts no clients, so FLSUN's `moonraker.conf` must list the LAN ranges, but the stock list is not confirmed. SSH root password not confirmed.
- Auto-fill: Moonraker server and printer info, `configfile` (`delta_radius`, `printer_radius`, `nozzle_diameter`), extruder and bed temperatures, webcam list. The delta bed is circular, so the build volume must be a diameter, not x and y. The model is not reported.
- Pitfalls: FLSUN uses its own Klipper build (not mainline), reportedly without delta radius recalculation (Guilouz wiki), so some objects and macros can differ. SlicerX must set a circular bed with the origin at center. A FLSUN 1.4 firmware image exists (flsun3d.com V400 Support). V400 motherboard firmware is flashed separately from the Pad.
- What to show: IP entry or scan, "Mainsail found at port 80, API at 7125", then the nozzle, delta bed diameter and height read from the printer. Ask for a key only on 401.

### UltiMaker (S3, S5 and S5 Pro bundle, S6, S7, S8, older UM3 family)

All have a local network API. Digital Factory is the cloud service.

- Discovery: Zeroconf service `_ultimaker._tcp.local.` (Cura's ZeroConfClient). Cura keeps only entries whose TXT `type` is `printer`. TXT properties Cura uses: `name`, `machine` (BOM number, mapped to a model), `firmware_version`, `cluster_size` (more than 1 means a cluster host). HTTP on port 80 (Cura does not hard-code a port). Cura also accepts manually added addresses and needs firmware 4.0.0 or newer for the cluster flow. On-device docs: `http://PRINTER/docs/api/` and `http://PRINTER/cluster-api/v1/` (swagger).
- Auth, two layers. (A) Cluster API (`/cluster-api/v1/...`): Cura's client sends no auth (printers, print_jobs, materials, upload). (B) Printer API (`/api/v1/...`): HTTP Digest. Flow: `POST /api/v1/auth/request` with form fields `application` and `user`, reply gives `id` and `key`. The user approves on the printer touchscreen. Poll `GET /api/v1/auth/check/{id}` until `authorized` (`unauthorized` or `unknown` otherwise). Then Digest with username `id` and password `key`. `GET /api/v1/auth/verify` returns 200 or 401 and is the only GET that needs auth. The Digital Factory cloud API (docs.api.ultimaker.com) uses OAuth2 and JWT with an Ultimaker account and is cloud only.
- Auto-fill: `GET /api/v1/system`: `guid`, `firmware`, `hostname`, `name`, `platform`, `variant` (for example "Ultimaker S5"), `hardware`. `GET /cluster-api/v1/printers`: `uuid`, `friendly_name`, `unique_name`, `machine_variant`, `status`, `firmware_version`, `ip_address`, `enabled`, `maintenance_required`, `firmware_update_status`, `latest_available_firmware`, `reserved_by`, `build_plate`, `material_station`, `configuration[]` (per extruder print core, material, guid, nozzle). `/cluster-api/v1/materials` lists material profiles. `/cluster-api/v1/print_jobs` is the queue. Upload: `POST /cluster-api/v1/print_jobs/` multipart with `owner` (user@host), `file`, optional `require_printer_name`, 30 s timeout in Cura. Cura picks UFP or G-code from the firmware and printer type. Printer API extras: `/api/v1/printer/heads`, `/printer/bed/temperature`, `/print_job/state`, progress, source.
- Pitfalls: the printer must be on Ethernet or Wi-Fi in the same subnet (community reports of discovery failing while the browser works). If the user does not tap Allow, the Digest request times out. Firmware before 4.0 has no cluster API. Which endpoints need Digest on current S-line firmware (7.x and 8.x) is not documented in what was read. A cluster size above 1 means the host is a cluster leader and jobs may be routed. Digital Factory cloud printing needs an account and is not the LAN path. Print core and material names are GUID based.
- What to show: a scan finds "UltiMaker S5" with firmware shown. If the printer API is needed: "Tap Allow on the printer screen" with a spinner (poll `auth/check`). Show the print core and material per extruder from `/cluster-api/v1/printers`. No password to type.

### Generic Klipper via Moonraker (Mainsail, Fluidd)

Covers any Klipper machine running Moonraker (Voron, RatRig, and others). Mainsail and Fluidd are web frontends over the same Moonraker API.

- Discovery: Moonraker's zeroconf component registers `_moonraker._tcp.local.` (instance name is the capitalized systemd unit name, else `Moonraker-<first 8 UUID chars>`). TXT keys: `uuid`, `https_port` (empty if SSL is off), `version`, `route_prefix`. The SRV port is the `[server]` port (default 7125, `ssl_port` default 7130). Optional `[zeroconf]` `mdns_hostname`. `enable_ssdp: True` (off by default) adds SSDP on 239.255.255.250:1900 with type `urn:arksine.github.io:device:Moonraker:1`. Fallback probe: `GET http://HOST:7125/server/info` (200, or a 401 or 403 JSON error also means Moonraker is there). `hostname.local` works if avahi runs.
- Auth, in order: (1) `trusted_clients` in `[authorization]` (newline list of IPs, CIDRs, FQDNs; default none; localhost is not trusted automatically) lets a client in with no credentials. (2) API key in the `X-Api-Key` header, read with `GET /access/api_key` from a trusted client, regenerated with `POST /access/api_key`. (3) JWT via `POST /access/login` with `Authorization: Bearer` (only if a user account exists and force_logins or auth is on). (4) One-shot token from `/access/oneshot_token`, valid about 5 s, single use, bound to the requesting IP, passed as `?token=` for requests that cannot set headers (WebSocket, image, stream, file download). An untrusted client gets HTTP 401 as JSON `{error:{code:401,...}}`. There is no pairing prompt.
- Auto-fill:
  - `GET /server/info`: `klippy_state`, `klippy_connected`, `moonraker_version`, `api_version`, `components`, `registered_directories`, `websocket_count`.
  - `GET /printer/info`: `state`, `state_message`, `hostname`, `software_version`, `klipper_path`, `config_file`.
  - `/printer/objects/query`, useful objects: `configfile` (`settings`: `extruder` and `extruderN` nozzle_diameter, filament_diameter, min_temp, max_temp; `stepper_x`, `stepper_y`, `stepper_z` position_min, position_max, position_endstop; `printer` kinematics, max_velocity, max_accel, max_z_velocity; `heater_bed`; `bed_mesh` mesh_min and mesh_max; `dual_carriage` for IDEX; delta radius), `toolhead` (`axis_minimum`, `axis_maximum`, `homed_axes`, `extruder`; `axis_maximum` is the effective travel limit), `extruder`, `heater_bed`, `fan`, `exclude_object`, `print_stats`, `virtual_sdcard`, `gcode_move`, `mmu` (Happy Hare), `firmware_retraction`.
  - Klipper does not report a model name. Closest hints: `GET /server/database/item?namespace=mainsail|fluidd`, hostname from `/printer/info`, config file names. `/server/config` returns the parsed `moonraker.conf`, whose `update_manager` entries often name a vendor.
- Pitfalls:
  1. 401 from an untrusted client: add the subnet (for example 192.168.1.0/24) to `trusted_clients` and restart Moonraker (config is read only at start), or use the API key.
  2. `cors_domains` affects only browsers (Origin header). A native app that sends no Origin is unaffected. A webview or WASM app on a custom origin is blocked unless the origin matches.
  3. Port 7125 is Moonraker. Port 80 (Mainsail or Fluidd nginx) normally reverse-proxies to 7125, but vendors sometimes expose Moonraker only on 7125 or only behind 80, 4408 or 4409.
  4. HTTPS on 7130 is active only when a certificate is configured.
  5. Klipper not ready: `/printer/*` returns 503 or `klippy_state` is startup, error or shutdown while `/server/info` still answers. Do not treat that as a connection failure.
  6. Webcam URLs are often relative (`/webcam/?action=stream`) and resolve against the frontend origin (port 80), not 7125.
  7. Webcams from `moonraker.conf` are read only. Database webcams come from the Mainsail or Fluidd UI.
  8. Upload is rejected while printing (409) or on checksum mismatch.
  9. Hostnames like `voron.local` fail on Windows without Bonjour, so use the SRV address.
- What to show: a found list with name (mDNS instance), IP, port, and "Klipper" plus `moonraker_version`. After the user taps one, auto-fill firmware, kinematics, extruder count, nozzle diameter per extruder, bed size (`toolhead` `axis_maximum` minus `axis_minimum`) and webcam presence. Ask only for the API key if the printer answers 401 (show the fix: add the network to `trusted_clients` and restart Moonraker, or run `curl http://IP:7125/access/api_key` on a trusted machine), and for the model if it cannot be inferred, and the bed radius if the printer is a delta. Give plain causes for 401, unreachable and Klipper not ready.

### OctoPrint, Repetier-Server, Duet RepRapFirmware, Marlin USB serial

Not covered by this research round. No findings are recorded here.

## 3. Gaps in sx-connect

Ordered by impact on getting a printer connected. Items in the same tier are roughly in order too. Paths are under `packages/connect/` unless they start with `/`.

### Printer is never found, or setup cannot start

1. Done in f2462f3 and fa34ef9. `MoonrakerConnector::probe()` asks `GET /server/info` on 7125, then 80 (a 401 or 403 JSON error counts), reads the host name and object list when open, and leaves a Snapmaker U1 or a Creality printer (its `/info` names a model) to their own connectors. The stale `discover()` comment is gone: the scan's mDNS browse (`mdns::browse_printers`) is wired into sx-link's `discover` RPC (`link/src/rpc.rs`), and `probe` into its `probe` RPC. Creality's 4408 and 4409 are asked by the Creality connector. Not done: Neptune, Qidi, Sovol and FLSUN announcing `_moonraker._tcp` on stock firmware is still unconfirmed.
2. Done in b6fc5825. `src/drivers/snapmaker/discover.rs` broadcasts the ASCII string `discover` to UDP 20054 from each local network, three times across the scan window, and parses the pipe separated replies (`NAME@IP|model:...|SACP:1`; a reply without an address takes the sender's). `probe` sends it to a typed address alone. A J1 or Artisan (by model, name or `SACP:1`) is listed on port 8888, a 2.0 machine on 8080. `docs/finding-printers.md` lists the broadcast. The reply's key names stay community knowledge (section 4).
3. Done in fa34ef9 and 16f51b7. The mDNS browse also asks for the list of service types (`_services._dns-sd._udp.local`) and reports `_Creality-<id>._udp.local` as a `creality` printer with `uid` `<id>`, the type OrcaSlicer's CrealityHostDiscovery looks for (unverified on hardware). `CrealityConnector::probe()` asks `GET /info` on 80 (model, host name, MAC; board codes read as model names) and then TCP 9999. A subnet sweep of 9999 was not added: a scan only asks the network, it never probes addresses. `docs/creality.md`, `catalog/src/methods.ts` and `docs/finding-printers.md` now say the scan finds stock Creality printers.
4. Done in 6a0444b2. PrusaLink has no network discovery, and no Prusa printer has been seen announcing `_prusalink._tcp` or `_prusa-link._tcp` (the names stay in `src/mdns.rs` `PRINTER_SERVICES`, marked unconfirmed). The driver comment no longer claims it, `docs/prusalink.md` says a scan may not find the printer, and `probe()` asks a typed address for `GET /api/version`: a reply whose `text` is PrusaLink, or a 401 with a Digest challenge, confirms it. Still open: the DHCP MAC prefix (109C70) or a subnet sweep.
5. Done in 336e8b7. `BambuConnector::connect()` reads the serial from the MQTT certificate's common name (TLS 1.2, no SNI) when the config has none, and the probe does the same when SSDP is blocked. Setup and the catalog no longer require the serial (aaf5bfa, 72fcd93).
6. Done in 55bb9707. `ElegooConnector::probe()` sends `M99999` to the typed `IP:3000` alone and fills name, model, mainboard id and firmware from the reply, so setup confirms the printer before the WebSocket is tried.
7. Done in 489975e7 and 10532a4d, experimental. `src/drivers/anycubic` runs `GET :18910/info`, the signed `POST` to `ctrlInfoUrl` (`md5(md5(token[0..16]) + ts + nonce)`), the AES-128-CBC decrypt (key `token[16..32]`, IV the reply's `data.token`), and MQTT over TLS on the printer's own address and port 9883. The login alone is tried first (anycubic_ha_local and anycubic-lan send no certificate) and `devicecrt` and `devicepk` are presented as a client certificate only when the broker refuses it (kobra-connect and kobra-lan-monitor present it). The broker is never taken from the reply's host. A dropped connection reruns the handshake, since the login rotates on restart. Status reads every `project.state` the community projects list, the ACE fills the slots, and pause, resume and stop go out on the web sender. Upload posts to `info.urls.fileUploadurl` (multipart `filename` and `gcode`, `X-File-Length`, from kobra-lan-monitor's packet capture) and start sends `print` `start` on the slicer sender topic (kobra-connect). `remain_time` is minutes (kobra-lan-monitor). The catalog method and `docs/anycubic.md` say experimental and untested on hardware. Mock: `mock-printers/src/anycubic.ts`, whose broker asks for the certificate, passes the driver contract.
8. Done in b1984d8a, experimental. `src/drivers/ultimaker` browses `_ultimaker._tcp.local` itself through `mdns::browse` (no change to `PRINTER_SERVICES`) and reads TXT as Cura does: `type=printer` only, `machine` mapped to the model by the `bom_numbers` of Cura's machine definitions, `firmware_version`, `name`, `cluster_size` above 1 marked as a group host. `probe` reads `/api/v1/system`. The cluster API carries jobs (multipart `owner`, `file`, `require_printer_name`), print cores and materials, and `pause`, `print`, `abort` actions; the printer API gives temperatures and the job state. Pairing (`auth/request`, `auth/check/{id}` every second, `declined` on `unauthorized`) returns `id:key` for Digest, which `connect` checks with `auth/verify` and the control fallback `PUT /api/v1/print_job/state` uses. The printer prints whatever arrives, so an upload is held in the session until the approved start. Firmware without the cluster API answers `not_supported` (Cura's 4.0 floor).
9. Done in b6fc5825. The J1, J1S and Artisan are found by the item 2 broadcast and `connect` and `authorize` answer `not_supported` with "the J1, J1S and Artisan protocol (SACP)", so setup can offer saving the G-code. No status client: the official Snapmaker-SACP docs cover the packet frame and `0x01 0x21` machine info only, not the TCP connection handshake with its touchscreen token or the temperature subscriptions, which are in community code alone (sm2uploader, nozzle-it-all).

### Printer is found but authentication fails or is mishandled

10. Done in c91db330. The driver reads `fun` (bit 0x20000000) into `PrinterHardware.developer_mode`, setup warns when it is off with the series' own path to the switch (`developerWhere` in `packages/app/src/first-run/bambu-lan.ts`), and a refused start while it is off says to turn on Developer Mode. Firmware needing it: X1 01.08.03.00, P1 01.08.02.00, A1 01.05.00.00, H2D 01.01.00.01. Done since on feat/bambu-connect: Developer Mode is optional. A printer that reports it off connects monitor-only (`status.live.monitorOnly`, status, events, camera and slots as capabilities), every command is refused before it is sent, and Print hands the plate to Bambu Connect, or saves it on Linux and in the browser. Setup, the catalog guides and the "No answer" text call Developer Mode optional (`packages/connect/docs/bambu-lan.md`).
11. Done in 0a8df3a5. `src/tls.rs` `bambu_lan_config()` and `bambu_client_config()` offer TLS 1.2 only, for MQTT 8883, FTPS 990, the 6000 camera and the serial read. Other LAN devices keep the default versions; RTSPS on 322 still offers 1.3. The certificate check still only records.
12. Done in 2f43ba83. `catalog/src/models/bambu.ts` has one guide per series from the wiki: X1 and H2 series Settings, LAN Only; P1 Settings, WLAN, LAN Only Mode; A1 Settings, page 3, LAN Only Mode. Every series names Developer Mode with its firmware, the X1 and H2 series mention LAN Only Liveview, and the X1 mentions the micro SD card. `docs/bambu-lan.md` has the same table.
13. Done in 8b7ca6cd. The claim is gone from `docs/bambu-lan.md`, `bambu.ts` and the app's setup text; they say to read the code again if the printer refuses it.
14. Done in c70776a2 and f2462f3. A 401 or 403 on `/server/info` asks `/access/info` and returns `Error::Login` (`not_trusted`, `key_wrong`, `login_required`). A `username` with the secret as password signs in with `POST /access/login`; the access token goes as `Authorization: Bearer` and is renewed with `POST /access/refresh_jwt` on a 401, then by a new login. Camera requests to Moonraker's own origin carry the same headers, so a protected webcam needs no `/access/oneshot_token` (one-shot tokens are for clients that cannot set headers; SlicerX always can). A wrong user login reports `key_wrong`.
15. Done in 76439613. The secret is the Digest password for `cfg.username`, else `maker`. A 401 with no Digest challenge it can answer, or a Digest answer refused before anything got in, is tried once with the secret as `X-Api-Key`, and whichever mode gets in is kept for the session. A Digest challenge with another algorithm (SHA-256) is written to the connection log (`SX_CONNECT_LOG`). The setup form asks for the password only, with an optional user name.
16. Done in 41a07dcf. (a) A status 401 is retried once with the token in a form body (kept when it works), then the session reconnects with the stored token, at most every 10 seconds, and reads as unreachable meanwhile; ten refusals in a row mean `pair_again`. (b) `authorize` stops at once on a 401 (login need `declined`) and posts `/api/v1/disconnect` on a timeout or error, so no prompt stays up; it polls every second, as Luban does. (c) A stored token answered with a new prompt clears that prompt and returns login need `pair_again`, which the setup panel words as a forgotten pairing. (d) Error text never carries the URL (`without_url`), so the query token stays out of logs; the body form is the fallback.
17. Done in 16f51b7. ha_creality_ws offers `wsslicer` (as the printer's web UI does) and OrcaSlicer offers no subprotocol. The driver offers `wsslicer` and, when the handshake fails, connects again with none, so either kind of printer connects. Which one a real K1 wants is still unverified.
18. Done in 16f51b7 for the native interface: a key, when set, goes as `Authorization: Bearer` on `/info` and uploads, as OrcaSlicer's CrealityPrint host sends it. Not done on the Moonraker path on purpose: Moonraker reads any `Authorization: Bearer` as a JSON Web Token and refuses the request when it is not one, so the Moonraker path keeps `X-Api-Key`.

### Wrong port, wrong storage or wrong protocol path

19. Done in f2462f3 and 72fcd93. When the configured port's `/server/info` is not Moonraker's JSON (Fluidd's page on 10088), the driver retries 7125 and otherwise says the port answered, but not as Moonraker. `FIND_KLIPPER` names 7125 and 80, and a new `FIND_QIDI` says the Fluidd page is on 10088 and the API on 7125.
20. Done in 16f51b7. `http::is_moonraker` counts only a JSON Moonraker reply, so Fluidd's page on a K2's 4408 is never taken for the API (when nginx proxies `/server/info` there, the answer is Moonraker's own and is right to use). `/info` is asked only on the web port (`httpPort`, 80) and must be a JSON object. Moonraker stays preferred on a rooted K1 and a stock K2, and the CFS is no longer lost there: setup reads it over 9999 (ea4de4d).
21. Done in 76439613. Each upload reads `GET /api/v1/storage` (`storage_list`) and uses the first available, writable storage, USB first, then local, then an SD card. With none it answers `not_found` asking for a USB drive; a printer without the endpoint gets `usb`. The returned path carries the storage, which `start` reuses.
22. Done in 336e8b7. `project_file` uses `file:///sdcard/<path>` for the X1, X1 Carbon, X1E, P1P, P1S, A1 and A1 mini (ha-bambulab `LEGACY_SDCARD_PRINTERS`) and `ftp:///<path>` for the rest and for a model not known yet. Test per model on hardware.
23. Done in 336e8b7. The storage is read as Bambu Studio reads it (`aux` bits 12 and 13, else `sdcard` refined by `home_flag` bits 8 and 9), and an upload is refused with the reason, before any FTPS, when there is no card and `fun2` bit 0 does not say internal storage, or when the card is faulty or read only. Bambu Studio stops a LAN send the same way (`PrintStatusLanModeNoSdcard`).
24. Done in 72fcd93 and a57af73. The manifest lists `lan:6000`, `lan:322`, `lan:1990` and `lan:2021` (not 1900), and `docs/bambu-lan.md` matches.
25. Done before this round (the camera route from the report: `ipcam.liveview.local`, then `ipcam.rtsp_url`, `disable` for liveview off, no 6000 try on an RTSPS printer). `snapshot()` stays `None` on RTSPS printers on purpose: sx-link makes stills from the stream's key frames (`link/src/camera.rs`, `h264.rs`).
26. Done in 16f51b7. The native session reads `webrtcSupport` (ha_creality_ws): a K2, or a K1 that reports 1, has its camera through `webrtc_offer` on 8000 (`/call/webrtc_local`), and `stream` and `snapshot` skip MJPEG on 8080. `camera_available` is true for every model, MJPEG or WebRTC.
27. Done in f2462f3. The webcam list is read once per session; webcams with `enabled` false are skipped; relative URLs resolve against the frontend: the scheme from `tls`, the configured port when it is a frontend's (80, 4408, 4409, 10088), else the default web port. A server without `/server/webcams/list` has no webcams. `flip_horizontal`, `flip_vertical` and `rotation` are read but not applied: the camera view has no orientation setting yet.
28. Done in 16f51b7. Board codes F001 Ender-3 V3, F002 Ender-3 V3 Plus, F005 Ender-3 V3 KE, F008 K2 Plus, F012 K2 Pro, F018 Hi, F021 K2 and F022 SPARKX i7 (OrcaSlicer's model table and ha_creality_ws) read as model names from `model` or `modelVersion`. The data root follows OrcaSlicer: `/usr/data` for the K1 family, `/mnt/UDISK` for every other model. The Ender and Hi data root and the K1 strings are still to check against a real `/info` reply.
29. Done in 16f51b7. The `path` field is left out for exactly OrcaSlicer's CFS capable models (F008, F012, F021, F022, K1, K1 SE, K1C, K1_CFS-C) and sent for the rest, `CR-K1 Max` included, as OrcaSlicer does. Unconfirmed on hardware.
30. Done in f2462f3. The upload sends `checksum` (the SHA-256 Moonraker checks), the text fields before the file, and its own timeout of at least five minutes (OrcaSlicer's) or longer at 64 KiB a second. `item.path` keeps subdirectories. `print=true` is not used on purpose: a start is its own approved step. `path` is not sent: uploads go to the root of `gcodes`.
31. Done in 76439613. A 409 on upload reads "busy: the file is printing, or the storage is in use or missing" and on start "busy: a print is running or the storage is in use", both `bad_state`.
32. Done in e40dd6b2. Ack 1 is `bad_state` busy, 2 `not_found`, and for a start 3 to 7 are refusals in words (MD5 failed, file read failed, resolution mismatch, unknown format, wrong model). A refused upload chunk names its `common_field` code (-1 to -3). `sdcp/error` messages become error events.
33. Done in e40dd6b2. A connection that gets no status within 8 seconds says the printer may already serve its limit of apps and to close ElegooSlicer and the Elegoo phone app. `docs/elegoo.md` has the row.
34. Partly done in e40dd6b2. Upload checks the attributes' `RemainingMemory` (bytes per OpenCentauri; the spec says bits) against the file and refuses before sending, and `list_files` reads Cmd 258 (`/local/`). Still open: `StartLayer` stays 0 (no start option asks for another), and the `Check=1` MD5 path is untested on hardware.
35. Decided in 41a07dcf: upload keeps `prepare_print`, which loads the file on the screen so it can also be started there. `POST /api/v1/upload` stores without loading, but no source shows a remote start of a file stored that way, so a send-only upload would leave a file SlicerX cannot start. Noted in `docs/snapmaker.md`.
36. Partly done in 16f51b7 and ea4de4d. The native session asks for `boxsInfo` on connect and every 30 seconds and fills `slots` and the hardware's filament units (OrcaSlicer's `parse_cfs_response`); a printer reached through Moonraker gets its CFS over 9999 at setup. tungstenite's default limits (16 MiB frames, 64 MiB messages) already take a long `retGcodeFileInfo2`. Still open: a file listing on the native path, and what the printer does with a second controller (no source describes it).

### Setup cannot auto-fill what the printer reports

37. Done in aaf5bfa. `DiscoveredPrinter` gains `bound` (SSDP `DevBind` `occupied`), `tls` and `uid`; `parse_ssdp` fills `bound`. `Devseclink`, `DevInf` and `DevCap` are not read: no source says what their values mean. Anycubic `modelId` and UltiMaker `machine` and `cluster_size` can use `model` and `uid`; those connectors are another workstream.
38. Done in fa34ef9. `browse_printers` reads Moonraker's TXT: `uuid` becomes `uid` (setup uses it as the printer's id), `version` the firmware, `https_port` sets `tls`. When mDNS is blocked, Enter IP instead probes 7125 and 80 (item 1).
39. Done in f2462f3. `PrinterHardware` gains `buildVolumeMm` (from `toolhead` `axis_maximum` less `axis_minimum`, a negative minimum counted as 0), `bedDiameterMm` (delta `print_radius`, else `delta_radius`), `kinematics`, `maxVelocityMmS`, `maxAccelMmS2` and `hostname`; the model is a vendor's `machine_name` from `/server/info` (QIDI, as OrcaSlicer reads it), or U1. Extruders come from `configfile` up to 16. Not done: Qidi model guessing from macros or the MCU, IDEX and `toolchanger`, `afc` and `ercf` detection, and the Neptune 4 `position_max` check.
40. Done. The H2C (`O1C2`, `O1C`) and A2L (`N9`) codes were already in `catalog/bambu-model-codes.json`; 336e8b7 adds old X1 firmware's `3DPrinter-X1` and `3DPrinter-X1-Carbon`, which Bambu Studio's `_parse_printer_type` maps to BL-P002 and BL-P001.
41. Done in 336e8b7. `print.printer_type` names the model when it is a known code, ahead of `get_version`, so an X1 and an X1 Carbon read apart.
42. Bambu has no cloud device list path. Grep for `api.bambulab`, `iot-service` and `user/bind` finds nothing in `packages/connect`. One sign-in could fill serial, model and access code for all printers. Needs a region switch (`.com` or `.cn`). Community-documented only. Still open: it signs in to a Bambu account with an API that is not official and can be blocked, so it waits for a decision on whether SlicerX should hold Bambu account credentials at all.
43. Done. The observe-only check landed before this round (CN equals the serial, issuer one of the bundled BBL CA, BBL CA2 RSA and ECC, never a refusal). c8e2766 follows a device CA the printer sends in the handshake (N7-V2, O1C2-V2, N6-V2) when a bundled CA signed it.
44. Partly done in 76439613. `connect` reads `/api/version`; the hardware carries its `firmware` and the `serial` from `/api/v1/info` (new `PrinterHardware.serial`, 804cfd33). The model is read only when `original` or `text` names one (MK4S, MK3.9, MK3.5, MINI, XL, Core One, Core One L), which no source confirms. Still open: the spec has no model field, so nothing reliable infers the model; `hostname`, `name`, `location`, `farm_mode`, `sd_ready` and `min_extrusion_temp` are not surfaced.
45. Documented in 76439613. Five MMU slots stay only when `mmu` is true (the MMU3 has five). `/api/v1/info` reports one `nozzle_diameter` and no toolhead count, so an XL's toolheads come from the catalog model (`prusa-xl-5-toolhead`); the driver says so in its comment and `docs/prusalink.md`.
46. Done in e40dd6b2. `parse_discovery` already kept `MainboardID` and `FirmwareVersion`. The session now asks for Cmd 1 on connect and reads `sdcp/attributes`: `hardware()` returns `MachineName`, `FirmwareVersion` and `MainboardID` (as `serial`), `CameraStatus` sets the camera flag, and `RemainingMemory` guards uploads.
47. Done in 16f51b7. The native status reads fans (`modelFanPct`, `caseFanPct`, `auxiliaryFanPct`) and the light (`lightSw`); `motion()` reads `curPosition`; `hardware()` gives the model (board codes mapped), the firmware from `modelVersion` (`Printer SW Ver`) and `hostname`; the probe fills `name`, `model` and `uid` (MAC). `PrinterStatus` itself has no host name or MAC field; they live in the hardware and the discovery result.
48. Done in 41a07dcf. The connect reply's `series` names the machine (A150, A250 or A350, matched inside strings such as "Snapmaker 2.0 A350"), and the head type gives one or two extruders, in `hardware()`. Serial and firmware are not in these replies. The discovery reply's `model` fills `DiscoveredPrinter.model` (b6fc5825).
49. Done in f2462f3 and fa34ef9. A Moonraker announced as `U1.local` is a `snapmaker` U1 in the scan; `SnapmakerConnector::probe()` finds a U1 by `print_task_config` or the host name U1 on 80, then 7125, and `connect()` looks for Moonraker on 80, then 7125, when no port is set. `print_task_config` fills `slots` and a `toolchanger` filament unit (`filament_exist`, `filament_type` with `filament_sub_type`, `filament_color_rgba`, as OrcaSlicer's SnapmakerPrinterAgent reads them). RFID details (`filament_detect`) are not read yet.
50. Done in f2462f3 and ea4de4d. QIDI Box slots come from `save_variables` (`box_count`, `filament_slot<N>`, `color_slot<N>`) and `box_stepper slot<N>` `runout_button`, named and colored from `officiall_filas_list.cfg`, as OrcaSlicer's QidiPrinterAgent reads them. `file_info()` falls back to the file list when `/server/files/metadata` answers 404. Plate previews from the G-code header are not read (nothing uses Moonraker thumbnails yet).
51. Done in 41a07dcf. `STOPPED` reads as a stop, `currentLine` over `totalLines` gives progress when `progress` is missing, and `x`, `y`, `z` and `homed` fill `motion()`. Still open: `moduleList`, `printStatus`, `airPurifierSwitch` and the enclosure endpoint (`led`, `fan`) are not read; HEATING and other status strings stay unconfirmed.
52. Done in e40dd6b2. `CurrentStatus` settles the conflict: while it holds 1, the Centauri Carbon codes apply (5, 6 and 10 paused; 1, 8 and 9 preparing; others printing); once the machine is idle the spec's retained sub status applies (9 finished, 8 idle with "The print was stopped"). `CurrentStatus` 2, 3 and 4 read as idle with "Receiving a file", "Calibrating" or "Running a self check". A nonzero `PrintInfo.ErrorNumber` outside a running print is an error with its reason. The `ErrorStatusReason` codes (3 runout, 6 jam, 7 leveling) live in task details (Cmd 321), which are not read.
53. Done in f2462f3. Status asks for the extruders `/printer/objects/list` names, and reads `webhooks` `state` and `state_message`: shutdown, error and startup report as `error` with Klipper's own message, and a 503 reads `/printer/info` for the same. Polling every second instead of the WebSocket is still open.
54. Done in 76439613. `STOPPED` is idle with "The print was stopped"; `IDLE` and `READY` are idle.

### Docs and catalog text

55. Done in a57af73. `docs/bambu-lan.md` lists 322 as the X1, P2S and H2 camera, 6000 for A1 and P1, and replaces the X1 camera row with the LAN Only Liveview fix; `src/drivers/bambu/README.md` already described RTSPS and now names the project URL, `printer_type` and the SD card check.
56. Partly done in 76439613. `docs/prusalink.md` and `FIND_PRUSALINK` name Settings > Network > PrusaLink, the password with user `maker`, and the 4.7.0 (5.1.0 on the MINI) firmware floors. Still open: MK3.5 and Core One L are not in the catalog, since a catalog model needs a printer profile in `packages/settings` (machine settings and G-code from the Orca extract, which is not in this tree).
57. Done in 72fcd93 and a57af73. `docs/moonraker.md` and `FIND_KLIPPER` say to restart Moonraker after editing `moonraker.conf`, that the printer's own address is not trusted on its own, which ports are the API (7125, or 80 through the frontend) and which are web pages (4408, 4409, 10088), and how a user login works.
58. Done in 72fcd93 and a57af73. `docs/creality.md` and the Creality find guide say Moonraker and Fluidd ship on the K2 family (7125 and 4408) and need root on a K1 or Ender-3 V3 KE, give the Root account information path and the community default passwords, and describe the CFS and WebRTC cameras. The K2 Plus note no longer says it has no camera.
59. Done in e40dd6b2. `FIND_CC` and `docs/elegoo.md` no longer advise a network control setting and point to the touchscreen's network settings and the router; they say to close other apps. `FIND_NEPTUNE` names Advance Settings (Obico), and every Neptune entry notes Moonraker on 7125 and the web page on 80, 4408 or 4409.
60. Partly done in 489975e7. The catalog find guide, the `anycubic` method summary, the setup panel's `lan_mode_off` words and `docs/anycubic.md` warn that LAN Mode removes the printer from the Anycubic account for good; `probe` reports `lanOnly` from `ctrlType`. Still open: Kobra 3, 3 V2, 3 Max, S1, S1 Max and Kobra 4 are not in the catalog yet (each needs a printer profile in `packages/settings`), and `modelId` is mapped in the driver (`model_name`) rather than stored in the catalog.
61. Done in 72fcd93. The catalog adds the QIDI X-Max 3, X-Plus 3, X-Smart 3, Q2 and X-Max 4 with OrcaSlicer 2.4.2's build volumes, all on `FIND_QIDI` with `checkedOnPrinter: false`. FLSUN S1 stays out until verified. Setup prefers the printer's own travel limits through `buildVolumeMm` (item 39). Sovol SV04 Klipper builds stay unconfirmed.
62. Done in b6fc5825. `docs/finding-printers.md` lists the UDP 20054 broadcast for the A series, J1 and Artisan, and `docs/snapmaker.md` says the U1's RTSP streams on 8554 and 8555 belong to the extended firmware and that the stock camera path is unconfirmed (a camera shows only when Moonraker lists one).

## 4. Unconfirmed

Verify each on a real printer or against an official source.

### Bambu Lab

- Exact Developer Mode firmware floors per model. X1 01.08.03.00, P1 01.08.02.00 and A1 01.05.00.00 appear in Bambu-adjacent official text for Authorization Control. H2D 01.01.00.01 and "P2S from launch" come only from SimplyPrint. The official Developer Mode wiki pages returned 404 or 402 from the research environment.
- Per-family menu paths. The official wiki gives X, H2 and P2S as Settings > LAN Only, P1 as Settings > WLAN > LAN Only Mode, and A as Settings, page 3, LAN Only Mode. SimplyPrint lists A1 as WLAN or Network and X1 as "LAN Mode", so paths may differ by firmware. Where Developer Mode sits relative to the access code on each family is not documented officially.
- Whether the access code rotates each time LAN Only Mode is switched on. SimplyPrint says only that it can show zeros.
- SSDP `DevModel` strings. BL-P001, BL-P002, C11, C12, C13, N1, N2S, N7, O1D, O1E and O1S are Orca and Studio `model_id` values and match SlicerX. H2C is O1C2 in Orca with an extra O1C file in Studio, and which one a given H2C announces is not confirmed. Whether SSDP `DevModel` equals the `model_id` on every model is verified for the H2D only, from SlicerX's recorded answer. The X1 names `3DPrinter-X1-Carbon` and `3DPrinter-X1` come from a community gist. No official SSDP spec exists; the code is in Bambu's closed network plugin.
- Which CA (BBL CA, BBL CA2 RSA, BBL CA2 ECC, device CA) each model and firmware presents, and whether the 2025 CA2 certificates apply per firmware or per hardware.
- Whether port 8883 stays open for read-only status in plain cloud mode on every post-Authorization-Control firmware, and whether the access code is visible in cloud mode on each screen. SlicerX relies on it for status without Developer Mode; the official page says status pushes are not affected by Authorization Control in cloud or LAN mode, but this is not yet checked on a printer. Also unchecked on hardware: whether the camera answers with Developer Mode off, and the Bambu Connect hand-off on Windows and macOS.
- The H2 LAN liveview toggle name and path ("Settings > General > LAN Mode Liveview") comes from OpenBambuAPI on firmware 01.02.00.00. The official wiki says only "Choose whether to enable LAN mode liveview" on the LAN Only page.
- Whether the P2S announces `DevModel` N7 and uses RTSPS 322 like the X1. Community video.md says P2S uses RTSP.
- ha-bambulab's `file:///sdcard/` versus `ftp:///` split for `project_file`, and the P2S TLS 1.3 hang, are community observations.
- Cloud login for the device list: Cloudflare and TFA behavior, token lifetime (about 3 months per OpenBambuAPI), and whether third-party apps may use the endpoint. The China host `api.bambulab.cn` comes from ha-bambulab string replacement.
- The meaning of `Devseclink` "secure" and `DevCap`, and whether `DevBind` "occupied" implies cloud-bound only, are inferred from observed packets.

### Prusa

- Whether Buddy firmware advertises any mDNS service (`_prusalink._tcp`, `_http._tcp`, `_octoprint._tcp`).
- Whether Buddy 5.x still accepts `X-Api-Key`, and on which versions. The spec lists Digest only, the forum says the API key is deprecated in 5.x, another source says `X-Api-Key` works.
- Exact JSON from `/api/v1/info` and `/api/version` on real Buddy firmware. Only the spec schema was read. Whether a model or printer-type field exists is unconfirmed (the spec `Version.printer` example "1.3.1" looks like a hardware revision).
- Whether `/api/version` answers without credentials on Buddy. The spec says all endpoints require Digest.
- Per-model storage names (`usb` versus `local`) and whether MK4 and Core One expose `/local`.
- The firmware version where each model went Digest-only, and the exact menu label (Password versus API key) per model.
- MK3.5 specifics: no source confirmed PrusaLink support or the menu on it.
- Prusa Connect cloud API: no public spec. Only the registration code location is sourced.
- HTTPS support and port for PrusaLink on Buddy. SlicerX docs mention TCP 443 without a source.

### Creality

- The exact mDNS service type and TXT records for K2 Plus, Hi and Ender-3 V3. Only `_Creality-<SN>._udp.local` on K1 and K1C is reported, by one community issue.
- Whether the `wsslicer` WebSocket subprotocol is required or merely accepted.
- Whether K2 Plus Moonraker on 7125 is reachable from the LAN without root and without a trusted-client restriction. Sources say stock and exposed, none official.
- Whether Ender-3 V3 and Hi expose Moonraker on stock firmware. Ender-3 V3 KE is reported disabled on stock. No data was found for the Hi.
- Exact JSON keys of `GET /info` beyond `model`. `hostname`, `mac` and `version` were seen in WebSocket telemetry, not confirmed for `/info`.
- The Creality Cloud relationship. Only one community issue says cloud runs over MQTT separately from LAN 9999. No official doc on a LAN-only mode or on whether cloud binding affects LAN control.
- Root default passwords vary by firmware (`creality`, `creality_2023`, `creality_2024`). No official Creality docs or root procedure were found on creality.com.
- K1 data root and Ender or Hi gcode folder (`/usr/data` versus `/mnt/UDISK`), and whether the upload `path` field is needed on each model.
- Behavior of K1 family and K2 when two LAN clients hold port 9999.
- Per-model camera port. K1 family 8080 MJPEG until firmware 1.3.5.22, then WebRTC on 8000, per community. Ender-3 V3 and Hi MJPEG port unconfirmed. K2 camera is also reported as moved off port 8000.

### Elegoo

- Whether the Centauri Carbon has any LAN-only or network control toggle. No source confirms the setting SlicerX docs mention.
- Exact `PrintInfo.Status` meanings. Sources conflict (spec: 9 Complete; CC notes: 9 starting). A completed or stopped code was not confirmed.
- The unit of `CurrentTicks` and `TotalTicks`. SlicerX assumes seconds.
- Whether the Centauri Carbon supports multiple simultaneous WebSocket clients, and how many. Only the cloud and video caps are documented.
- Behavior on newer Centauri Carbon firmware (1.1.x and later) and on the Centauri Carbon 2. No release notes were fetched.
- Whether the upload endpoint requires `Check` and MD5 or accepts an unchunked upload, and the exact success JSON.
- Whether Neptune 4 firmware advertises `_moonraker._tcp`.
- Whether Elegoo's shipped `moonraker.conf` trusts the LAN by default, and the exact Moonraker version shipped.
- Fluidd and Mainsail ports on stock Elegoo firmware (80, 4408, 4409 come from community guides).
- Touchscreen menu paths for the IP (Neptune: Advance Settings per one community guide; Centauri Carbon: unverified).
- No official Elegoo help center or wiki page was retrieved, so no official Elegoo source confirms any Centauri Carbon network detail.
- The unit of `RemainingMemory` in the attributes (OpenCentauri says bytes, the spec says bits), and whether `CurrentStatus` reads 1 for the whole of a print on the Centauri Carbon, which the status mapping relies on.

### Snapmaker

- Exact key names and order in the UDP 20054 reply (`model:`, `status:`, `sacp:`, `token:`). Only a community example exists. Whether J1 and Artisan replies mark SACP is unconfirmed.
- The U1 DNS-SD service type and port (80 or 7125). Hostname `U1` via zeroconf is reported.
- Whether stock (non-extended) U1 firmware exposes Moonraker on 7125 to the LAN or only through nginx on 80. SlicerX README says nginx on 80, the u1-moonraker config says 7125.
- Which A-series firmware dropped the HTTP API in favor of SACP. One forum post says "latest firmware". A350 firmware 1.21 still uses HTTP per the Home Assistant PR.
- Status string values beyond IDLE, RUNNING and PAUSED, and dual-extruder field names (`nozzleTemperature1` and `2`). Luban heartbeat code was not fully read.
- Whether remote `start_print` works without a touchscreen press, and whether the token belongs in the query or the body on newer A-series firmware.
- The token approval window (about 60 s, community) and whether tokens persist across power cycles (Cura sender and 3D Etplus say lost on power off; Snapmaker2Plugin says the prompt appears after the Snapmaker starts up).
- SACP command IDs for model, serial and firmware. Only temperature command sets (0x10, 0x14) and peer IDs from a community write-up were found.
- U1 official support pages on network setup and any official API docs were not found. "Require Login" and the RFID and `print_task_config` object names come from community repos.

### Anycubic

- How a LAN-mode printer is discovered (SSDP, mDNS, UDP broadcast or DHCP only). hass-anycubic claims auto-detect and hass-anycubic-next mentions DHCP matchers.
- The request signing scheme and AES key derivation for `POST /ctrl`. Ports 18910 and 9883 come from single secondary sources (anycubic_ha_local README, kobra-connect). No official Anycubic LAN API doc was found.
- Kobra 3, S1 and X handshake differences (Kobra 2 is unsigned) are from community validation only. Firmware minimums for LAN mode are unknown.
- The cloud MQTT broker host and port 7125, from one community doc.
- Whether the LAN broker ever asks for the client certificate from `/ctrl` (kobra-connect and kobra-lan-monitor present it, anycubic_ha_local and anycubic-lan do not), the `gcode_upload` reply and where an uploaded file lands for `print` `start`.

### Qidi, Sovol, FLSUN

- Whether stock Qidi firmware announces `_moonraker._tcp`, and its stock `trusted_clients` list. Whether Plus 4 and Q1 Pro serve Fluidd on 10088 or 80 (confirmed only for X-Max 3 and the X series).
- Whether the Q1 Pro Fluidd "account management module" forces logins on the API.
- Qidi Studio's own network path (QIDI Link cloud and any LAN protocol) was not read.
- Sovol SV08: the `trusted_clients` list is from a community-posted factory config, stock mDNS announcement unconfirmed, SV08 Max not checked.
- FLSUN: whether the S1 runs Klipper. V400 stock Mainsail port 80, `trusted_clients`, SSH credentials and mDNS are not confirmed from an official FLSUN source.

### UltiMaker

- Whether current S-line firmware (7.x, 8.x, 9.x) requires Digest on `/cluster-api` calls, and whether `/api/v1/auth` is still the pairing path for third-party apps. Cura's client sends no auth to the cluster API.
- Whether UDP discovery exists (for example port 32137). Not confirmed and probably not used.
- The on-printer menu path for allowing an auth request, and the printer API port (assumed 80).
- Whether `require_printer_name` routes a job on a standalone printer as on a group host, and whether 7.x and later firmware still takes the cluster API's `print_jobs/{uuid}/action` without a login.

### Generic Klipper and Moonraker

- Whether `/server/info` itself needs auth. The fetched `authorization.py` summary lists only `/access/login`, `/access/refresh_jwt` and `/access/info` as unauthenticated. SlicerX `is_moonraker` treats 401 and 403 as Moonraker, consistent with that.
- Exact `configfile.settings` key names (`stepper_x` `position_max`, `printer` kinematics, `delta_radius`) were not re-verified against a live `/printer/objects/query` response. The Klipper config reference was not fetched.
- Mainsail's database key for the printer name (`general.printername` under namespace `mainsail`) and Fluidd's equivalent.
- Nginx proxying of 7125 on port 80 (MainsailOS, KIAUH) and Creality's 4408 and 4409 frontend ports are from general knowledge, not fetched sources.
- Whether the zeroconf SRV port is always 7125 or the proxied port. The docs say "configured via host info settings".
- Whether Sovol SV04 variants run Klipper.
- The one-shot token details (about 5 s, IP bound, single use) come from a docs summary. The accepted HTTP method (GET or POST) for `/access/oneshot_token` was not verified.
- The Moonraker `[zeroconf]` announcement was not shown in the fetched documentation page. SlicerX's `finding-printers.md` says projects announce it, which could not be verified.

## 5. Sources

O = official (vendor or project that owns the protocol). C = community.

### Bambu Lab

- O: Bambu Lab Wiki, How to enable LAN Mode on Bambu Lab printers. https://wiki.bambulab.com/en/knowledge-sharing/enable-lan-mode
- O: Bambu Lab Wiki, Third-party Integration with Bambu Lab Products. https://wiki.bambulab.com/en/software/third-party-integration
- O: Bambu Lab Blog, Updates and Third-Party Integration with Bambu Connect. https://blog.bambulab.com/updates-and-third-party-integration-with-bambu-connect
- O: Bambu Lab Wiki, Bambu Connect (URL scheme for third-party software, downloads, platforms). https://wiki.bambulab.com/en/software/bambu-connect
- O: BambuStudio `DeviceManager.cpp` (ipcam liveview, rtsp_url, printer_type parsing). https://raw.githubusercontent.com/bambulab/BambuStudio/master/src/slic3r/GUI/DeviceManager.cpp
- O: OrcaSlicer BBL machine profiles (model_id codes). https://github.com/OrcaSlicer/OrcaSlicer/tree/main/resources/profiles/BBL/machine
- O: BambuStudio `resources/printers` (model code files). https://github.com/bambulab/BambuStudio/tree/master/resources/printers
- C: OpenBambuAPI `mqtt.md`. https://github.com/Doridian/OpenBambuAPI/blob/main/mqtt.md
- C: OpenBambuAPI `video.md`. https://github.com/Doridian/OpenBambuAPI/blob/main/video.md
- C: OpenBambuAPI `tls.md`. https://github.com/Doridian/OpenBambuAPI/blob/main/tls.md
- C: OpenBambuAPI `ftp.md`. https://github.com/Doridian/OpenBambuAPI/blob/main/ftp.md
- C: OpenBambuAPI `cloud-http.md` (user/bind device list). https://github.com/Doridian/OpenBambuAPI/blob/main/cloud-http.md
- C: ha-bambulab pybambu (`utils.py`, `const.py`, `bambu_client.py`, `certs/`). https://github.com/greghesp/ha-bambulab/tree/main/custom_components/bambu_lab/pybambu
- C: ha-bambulab integration overview (authorization control notes). https://docs.page/greghesp/ha-bambulab
- C: SimplyPrint, LAN-only mode and Developer Mode, how to enable. https://help.simplyprint.io/en/article/bambu-lab-lan-only-mode-and-developer-mode-how-to-enable-xa0hch/
- C: Gist, fake SSDP discovery message for Bambu Studio and Orca. https://gist.github.com/Alex-Schaefer/72a9e2491a42da2ef99fb87601955cc3

### Prusa

- O: PrusaLink OpenAPI spec (Prusa-Link-Web). https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml
- O: Prusa Help, Network Connection (CORE One L, CORE One, MK4S, MK3.9S). https://help.prusa3d.com/article/network-connection-core-one-l-core-one-mk4s-mk3-9s_736892
- O: Prusa-Firmware-Buddy issue 3161 (PrusaLink credentials redesign). https://github.com/prusa3d/Prusa-Firmware-Buddy/issues/3161
- O: Prusa-Firmware-Buddy issue 4811 (material info not exposed). https://github.com/prusa3d/Prusa-Firmware-Buddy/issues/4811
- O: Prusa-Firmware-Buddy issue 3809 (mDNS and hostname request). https://github.com/prusa3d/Prusa-Firmware-Buddy/issues/3809
- O: Prusa Help, Connect Registration Failed. https://help.prusa3d.com/article/connect-registration-failed_654926
- C: Home Assistant PrusaLink integration docs. https://www.home-assistant.io/integrations/prusalink/
- C: Home Assistant `prusalink` manifest.json (DHCP 109C70). https://github.com/home-assistant/core/blob/dev/homeassistant/components/prusalink/manifest.json
- C: Prusa Forum, Prusa Link Local Login Credentials. https://forum.prusa3d.com/forum/hardware-firmware-and-software-help/prusa-link-local-login-credentials/
- C: Prusa Forum, MK4 PrusaLink authentication issues. https://forum.prusa3d.com/forum/english-forum-original-prusa-i3-mk4-hardware-firmware-and-software-help/mk4-ui-issue-prusalink-authentication-issues/

### Creality

- O: OrcaSlicer `CrealityPrint.cpp`. https://github.com/OrcaSlicer/OrcaSlicer/blob/main/src/slic3r/Utils/CrealityPrint.cpp
- O: OrcaSlicer PR 15900 (K2 port 4408 versus native API). https://github.com/OrcaSlicer/OrcaSlicer/pull/15900
- O: CrealityOfficial K1_Series_Klipper releases. https://github.com/CrealityOfficial/K1_Series_Klipper/releases
- C: ha_creality_ws. https://github.com/3dg1luk43/ha_creality_ws
- C: ha_creality_ws PR 126. https://github.com/3dg1luk43/ha_creality_ws/pull/126
- C: ha_creality_ws `utils.py`. https://raw.githubusercontent.com/3dg1luk43/ha_creality_ws/main/custom_components/ha_creality_ws/utils.py
- C: HelixScreen K2 page. https://helixscreen.org/dev/printers/creality-k2/
- C: HelixScreen issue 1447. https://github.com/prestonbrown/helixscreen/issues/1447
- C: HelixScreen issue 1468. https://github.com/prestonbrown/helixscreen/issues/1468
- C: Creality Helper Script wiki, access to web interface. https://guilouz.github.io/Creality-Helper-Script-Wiki/configurations/access-to-web-interface/
- C: My Creality K1 Guide, Moonraker. https://meteyou.github.io/creality-k1/software/moonraker/
- C: OpenK1, rooting K1 Max and KE. https://www.openk1.org/index.php/articles/rooting-the-k1-max-and-ke
- C: OctoEverywhere K1 and K1 Max remote access guide. https://blog.octoeverywhere.com/remote-access-for-the-creality-k1-and-k1-max/

### Elegoo

- O: SDCP V3.0.0 spec (cbd-tech). https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0
- O: Moonraker configuration docs. https://moonraker.readthedocs.io/en/latest/configuration/
- C: OpenCentauri, Centauri Carbon SDCP WebSocket API. https://docs.opencentauri.cc/software/api/
- C: WalkerFrederick/sdcp-centauri-carbon. https://github.com/WalkerFrederick/sdcp-centauri-carbon
- C: Obico, Elegoo Neptune 4 setup. https://www.obico.io/blog/elegoo-neptune-4-and-obico-ai-3d-printing-revolution/
- C: OpenElab, why is my printer not connected to ELEGOO Slicer. https://openelab.io/blogs/learn/why-is-my-printer-not-connected-to-elegoo-slicer
- C: Printago, Centauri Carbon slicer guide. https://printago.io/guides/elegoo-centauri-carbon-slicer

### Snapmaker

- O: Snapmaker 2.0 Web API documentation thread (UDP 20054 discover). https://forum.snapmaker.com/t/documentation-of-the-web-api/20976
- O: Snapmaker Luban `SstpHttpChannel.ts`. https://raw.githubusercontent.com/Snapmaker/Luban/main/src/server/services/machine/channels/SstpHttpChannel.ts
- O: Snapmaker/u1-moonraker. https://github.com/Snapmaker/u1-moonraker
- O: Snapmaker-SACP. https://github.com/Snapmaker/Snapmaker-SACP/
- O: Snapmaker forum, do Snapmaker 2.0 devices have a webpage. https://forum.snapmaker.com/t/do-snapmaker-2-0-devices-have-a-webpage/5455/51
- C: nozzle-it-all PR 46. https://github.com/James-Jennison/nozzle-it-all/pull/46
- C: ifnull/homeassistant-snapmaker PR 1. https://github.com/ifnull/homeassistant-snapmaker/pull/1
- C: CuraSnapmakerSender `SnapmakerApiV1.py`. https://github.com/Razor10021990/CuraSnapmakerSender/blob/main/SnapmakerApiV1.py
- C: 3D Etplus, Bridging the J1S to Moonraker. https://www.3detplus.ch/bridging-the-snapmaker-j1s-to-the-moonraker-ecosystem/
- C: u1-companion. https://github.com/zkasuran/u1-companion
- C: SnapmakerU1-Extended-Firmware `firmware_config`. https://snapmakeru1-extended-firmware.pages.dev/firmware_config
- C: sm2uploader. https://github.com/macdylan/sm2uploader
- C: Snapmaker2Plugin. https://github.com/macdylan/Snapmaker2Plugin/blob/main/README.en-us.md

### Anycubic

- O: AnycubicSlicer issue 23 (LAN discovery failure). https://github.com/ANYCUBIC-3D/AnycubicSlicer/issues/23
- C: hass-anycubic. https://github.com/delormejonathan/hass-anycubic
- C: anycubic_ha_local. https://github.com/chrisfore/anycubic_ha_local
- C: anycubic-lan on PyPI. https://pypi.org/project/anycubic-lan/
- C: kobra-connect MQTT commands. https://github.com/rvanderp3/kobra-connect/blob/main/docs/mqtt-commands.md
- C: kobra-lan-monitor. https://github.com/A-to-PC/kobra-lan-monitor
- C: Printer Tools, Anycubic Kobra X guide. https://printertools.app/blog/guides/connect-anycubic-kobra-x-printer-tools

### Qidi, Sovol, FLSUN

- O: QIDITECH/QIDI_MAX3 (Fluidd port 10088). https://github.com/QIDITECH/QIDI_MAX3
- O: QIDITECH/QIDI_Q1_Pro (Fluidd account module). https://github.com/QIDITECH/QIDI_Q1_Pro
- C: HelixScreen QIDI support notes. https://github.com/prestonbrown/helixscreen/blob/main/docs/devel/printers/QIDI_SUPPORT.md
- C: Obico, QIDI Plus4 guide. https://www.obico.io/blog/qidi-plus4-klipper-remote-access-and-ai/
- C: Sovol SV08 factory-modified `moonraker.conf`. https://github.com/MPC561/Sovol-SV08-Factory-Modified-Klipper/blob/main/moonraker.conf
- C: SimplyPrint, Sovol SV08 Klipper guide. https://simplyprint.io/setup-guide/sovol/sv08/klipper-powered
- C: SimplyPrint, FLSUN V400 Klipper guide. https://simplyprint.io/setup-guide/flsun/v400/klipper-powered
- C: Guilouz Klipper-Flsun-Speeder-Pad wiki. https://github.com/Guilouz/Klipper-Flsun-Speeder-Pad/wiki

### UltiMaker

- O: Cura `ZeroConfClient.py`. https://raw.githubusercontent.com/Ultimaker/Cura/main/plugins/UM3NetworkPrinting/src/Network/ZeroConfClient.py
- O: Cura `LocalClusterOutputDeviceManager.py`. https://raw.githubusercontent.com/Ultimaker/Cura/main/plugins/UM3NetworkPrinting/src/Network/LocalClusterOutputDeviceManager.py
- O: Cura `ClusterApiClient.py`. https://raw.githubusercontent.com/Ultimaker/Cura/main/plugins/UM3NetworkPrinting/src/Network/ClusterApiClient.py
- O: Cura `LocalClusterOutputDevice.py`. https://raw.githubusercontent.com/Ultimaker/Cura/main/plugins/UM3NetworkPrinting/src/Network/LocalClusterOutputDevice.py
- O: Cura `ClusterPrinterStatus.py`. https://raw.githubusercontent.com/Ultimaker/Cura/main/plugins/UM3NetworkPrinting/src/Models/Http/ClusterPrinterStatus.py
- O: UltiMaker Digital Factory Cloud API. https://docs.api.ultimaker.com/faq/digital_factory.html
- C: UltiMaker printer REST API description (gist). https://gist.github.com/SimonIT/ea672554e9d642b517202125b10d3b37
- C: UltiMaker Community, API authentication threads. https://community.ultimaker.com/topic/22128-ultimaker-3-digest-authentication-printing-via-api/

### Moonraker (generic Klipper, also used by Elegoo, Qidi, Sovol, FLSUN, Snapmaker U1)

- O: Moonraker authorization web API. https://moonraker.readthedocs.io/en/latest/external_api/authorization/
- O: Moonraker printer administration API. https://moonraker.readthedocs.io/en/latest/external_api/printer/
- O: Moonraker server administration API. https://moonraker.readthedocs.io/en/latest/external_api/server/
- O: Moonraker configuration (port 7125, `trusted_clients` default none). https://moonraker.readthedocs.io/en/latest/configuration/
- O: Moonraker webcams API. https://moonraker.readthedocs.io/en/latest/external_api/webcams/
- O: Moonraker file manager API. https://moonraker.readthedocs.io/en/latest/external_api/file_manager/
- O: Moonraker machine API. https://moonraker.readthedocs.io/en/latest/external_api/machine/
- O: Moonraker `zeroconf.py`. https://raw.githubusercontent.com/Arksine/moonraker/master/moonraker/components/zeroconf.py
- O: Moonraker `authorization.py`. https://raw.githubusercontent.com/Arksine/moonraker/master/moonraker/components/authorization.py
