# Anycubic (LAN Mode)

Plugin id `anycubic`, experimental. See `../../../docs/anycubic.md` for the full description.

## Wire protocol

- `GET http://IP:18910/info`, then a signed `POST` to its `ctrlInfoUrl` (`sign = md5(md5(token[0..16]) + ts + nonce)`), whose `data.info` decrypts with AES-128-CBC (key `token[16..32]`, IV `data.token`) to the broker login, the device id and, on some firmware, a client certificate.
- MQTT 3.1.1 over TLS on the printer's port 9883: reports on `.../printer/public/{modelId}/{deviceId}/{type}/report`, requests on `.../web/printer/{modelId}/{deviceId}/{type}`.
- The login alone first; the client certificate only when the broker refuses that.
- `info` every 15 seconds, the ACE (`multiColorBox`, `getInfo`) every 30. `print` `pause`, `resume`, `stop` with `taskid` "-1".
- Upload: multipart `POST` to `info.urls.fileUploadurl` (`filename`, `gcode`, `X-File-Length`). Start: `print` `start` on the `slicer` sender topic.
- No G-code console, camera not read (FLV on 18088).

## Sources

- anycubic_ha_local (MIT): https://github.com/chrisfore/anycubic_ha_local
- kobra-connect (Apache-2.0): https://github.com/rvanderp3/kobra-connect
- kobra-lan-monitor (MIT): https://github.com/A-to-PC/kobra-lan-monitor

## Unverified

All of it: no Anycubic document exists and nothing here has met a printer.
