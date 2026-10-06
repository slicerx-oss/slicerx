# Anycubic (LAN Mode)

Connects to Anycubic Kobra 3, Kobra 3 V2, Kobra 3 Max, Kobra S1, Kobra S1 Max, Kobra 4 and Kobra X printers in LAN Mode: status, temperatures, progress, the ACE filament slots, sending and starting files, pause, resume and stop. Experimental: written from community projects and untested on a printer. No Anycubic document describes this interface, and a firmware update can change it.

## For users

### Before you start: LAN Mode leaves the Anycubic cloud

Turning on LAN Mode removes the printer from your Anycubic account for good. Turning it off later does not bring it back; you would pair it again in the Anycubic app. Remote printing from the Anycubic app stops while LAN Mode is on.

### On the printer

1. On the touchscreen, open Settings, then Network, and connect the printer to your network. Note the IP address. Your router's device list shows it too.
2. In Settings > Network, turn on LAN Mode, after reading the warning above.
3. No code or password is needed.

### In SlicerX

1. Add a printer, choose Anycubic and enter the IP address. SlicerX asks the printer for its model and whether LAN Mode is on. A scan does not find Anycubic printers.
2. SlicerX reads the model, firmware and the ACE slot colors from the printer.

### Network and firewall

TCP 18910 (the printer's handshake) and TCP 9883 (its MQTT broker, over TLS). A guest Wi-Fi or client isolation blocks both.

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "is in cloud mode: turn on LAN Mode" | LAN Mode is off, or the printer dropped back to cloud mode on its own. Turn it on again in Settings > Network. |
| "this printer's LAN handshake (the unsigned one of the Kobra 2 generation) is not supported" | Older firmware, such as the Kobra 2 family, uses a handshake SlicerX does not speak. |
| "uploads on this printer ... not supported" | The printer's info report names no upload address. Save the G-code to a USB drive and start it on the printer; SlicerX still shows its progress. |
| Offline for a few seconds after the printer restarts | The printer changes its login on every restart. SlicerX shakes hands again by itself. |
| ACE slots show late | The ACE answers only when asked. SlicerX asks every 30 seconds. |

## For integrators

Plugin id `anycubic`, experimental (hidden unless experimental connectors are on). Capabilities: status, events, upload, start, pause, resume, cancel, filament slots. There is no G-code console and no camera (the printer streams FLV on 18088, which is not read).

Printer config: `host`, optional `port` (the handshake port, 18910). No credential.

### Handshake

1. `GET http://IP:18910/info`: `modelId`, `modelName`, `cn` (serial), `token`, `ctrlInfoUrl`, `ctrlType` (`cloud` when LAN Mode is off: the login need is `lan_mode_off`). A reply without `token` or `ctrlInfoUrl` is the older unsigned handshake and answers `not_supported`. `ctrlInfoUrl` must be on the printer's own address.
2. `POST {ctrlInfoUrl}?ts=&nonce=&sign=&did=`: `ts` in milliseconds, a 6 character nonce, `did` 32 random characters, and `sign = md5(md5(token[0..16]) + ts + nonce)` in hex.
3. The reply's `data.info` is base64 of AES-128-CBC with the key `token[16..32]` and the IV `data.token` (cut or zero padded to 16 bytes), PKCS#7 padded. It decrypts to JSON with `broker` (`mqtts://IP:9883`), `username`, `password`, `deviceId`, and on some firmware `devicecrt` and `devicepk`, a client certificate and key in PEM.

The broker is reached on the printer's own address and the port `broker` names, over TLS that accepts the printer's self-signed certificate. The login alone is tried first (anycubic_ha_local and anycubic-lan send no certificate); when the broker refuses it and the handshake gave a client certificate, the certificate is presented, and for that printer it is tried first from then on. Nothing from the handshake is written to a log. The login changes on every printer restart, so a dropped connection runs the handshake again, every 2 seconds, then every 5 while it fails.

### MQTT

Reports arrive on `anycubic/anycubicCloud/v1/printer/public/{modelId}/{deviceId}/{type}/report` (subscribed with `#`). Requests go to `anycubic/anycubicCloud/v1/web/printer/{modelId}/{deviceId}/{type}` as `{type, action, timestamp, msgid, data}`. `info` is asked every 15 seconds (`action` `query`) and the ACE every 30 (`multiColorBox`, `getInfo`). `tempature` (the firmware's spelling), `fan` and the progress form of `print` reports are folded into the last `info`.

Status: `state` `free` is idle (`project` is null then; `last_project` is not read as current). While `busy`, `project.state` `preheating`, `auto_leveling`, `vibrating` and `flow_calibrating` prepare; `printing`, `resuming`, `resumed` and `stopping` print; `pausing` and `paused` (or `project.pause` 1 or 2) pause; `finished` is finished; `stoped` is idle with "The print was stopped"; any other word prepares, with the word shown. `project.progress` is a percentage and `remain_time` minutes. ACE slots are `A1` to `A4` for the first box, with `type`, `color` (`[r, g, b]`) and `consumables_percent`.

Control: `print` with `pause`, `resume` or `stop` and `{"taskid": "-1"}`, as the Anycubic app sends them.

Upload: `POST` to the `urls.fileUploadurl` the `info` report names (`http://IP:18910/gcode_upload?s=<secret>`, which must be on the printer's own address and is never logged), multipart with a `filename` text field, the file under `gcode`, and an `X-File-Length` header, as kobra-lan-monitor sends it. Start: `print` `start` on the `slicer` sender topic (`.../slicer/printer/{modelId}/{deviceId}/print`; the printer takes a start from the slicer sender only, per kobra-connect) with `{"taskid": "-1", "filename": NAME, "filepath": "/", "filetype": 1}`.

### Testing

`anycubic_lan_mode_passes_the_contract` in `tests/drivers.rs` runs the driver contract against the fake in `mock-printers/src/anycubic.ts` (`--only anycubic`; the broker on `anycubic-mqtt` asks for the client certificate, so the driver's fallback to it is exercised). Its control port takes `POST /anycubic {cloud, rotate}` to turn LAN Mode off or change the login as a restart does. Unit tests for the signature, the decrypt and the status are in `src/drivers/anycubic/mod.rs`.

### Sources

All community, none from Anycubic: anycubic_ha_local (MIT, https://github.com/chrisfore/anycubic_ha_local), anycubic-lan (MIT, https://pypi.org/project/anycubic-lan/), kobra-connect (Apache-2.0, https://github.com/rvanderp3/kobra-connect, `docs/mqtt-commands.md`), kobra-lan-monitor (MIT, https://github.com/A-to-PC/kobra-lan-monitor). Read as protocol references only; this driver does not copy their code.

### Untested on hardware

Everything. Check first: the handshake on Kobra 3 and S1 firmware, whether the broker ever asks for the client certificate, the upload reply and where the file lands for the start, the `project.state` words during a print and after it completes, and whether the Kobra X speaks this handshake.
