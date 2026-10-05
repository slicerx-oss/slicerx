# Live camera

SlicerX shows a printer's camera as live video, not stills. Each connector reads the camera at the quality the printer gives, and `sx-link` passes it to the app. Snapshots stay as the fallback for printers that offer no stream.

## For users

### What each printer gives

| Printer | Video | Notes |
| --- | --- | --- |
| Bambu Lab A1 and P1 | JPEG stream, port 6000 | Needs LAN Only Mode on and the access code. |
| Bambu Lab X1 and H2 | H.264 over RTSPS, port 322 | Same access code. SlicerX tries port 6000 first and switches to RTSPS when the printer refuses it. |
| Klipper with Moonraker | WebRTC (crowsnest camera-streamer, mediamtx, go2rtc) or MJPEG (crowsnest, mjpg-streamer) | Needs a webcam set up in Mainsail or Fluidd. WebRTC is tried first; MJPEG is the fallback. HLS webcams fall back to stills. |
| OctoPrint | MJPEG | The stream URL in Settings, Webcam and Timelapse, on the same host. |
| Creality K1, Ender and Hi | MJPEG, port 8080 | |
| Creality K2 | WebRTC, port 8000 | Uses the same offer flow as the printer's own web page. |
| Elegoo Centauri Carbon | MJPEG, port 3031 | Started on request. |
| Prusa with PrusaLink | Stills, about three a second | The Buddy camera answers stills only. |
| Duet, Snapmaker 2.0 | None | |
| Any other IP camera | RTSP, RTSPS, MJPEG or ONVIF | Set the camera address on the printer: `rtsp://192.168.1.60/live`, or `onvif://192.168.1.60` to let the camera give its own stream address. No user name or password in the address. The login goes in the keychain. |

USB webcams on your own computer are opened by the app itself and do not go through a printer connection.

### WebRTC

WebRTC gives the lowest delay and the sender adapts its bitrate to the path, so it shows a single quality level. The video runs between your browser and the camera directly, so it works only where your browser can reach the printer. SlicerX passes the offer and answer through `sx-link` (browsers cannot call a printer's web address from the hosted app), then leaves the video alone. If WebRTC does not connect within a few seconds, or the camera has none, SlicerX switches to frames relayed through `sx-link`, which offers Low, Medium and High.

### Finding cameras

Choose Find cameras to scan for ONVIF cameras. Each one comes back with the address to put in a printer's camera setting. ONVIF cameras usually want the user name and password you set on the camera; SlicerX asks for them once and keeps them in the keychain. Some cameras have ONVIF switched off until you turn it on in their own settings.

### Quality and speed

The player has Low, Medium and High. Low sends 10 frames a second (key frames only for H.264), Medium 15 and High whatever the camera gives. SlicerX looks at the camera before it starts and opens no higher than it can sustain, and it steps down on its own when your screen falls behind, then back up after ten calm seconds. Frames are dropped, never queued, so the picture stays current instead of drifting behind. (These levels apply to frames relayed through `sx-link`, not to WebRTC.)

### Away from home

Not built yet. The video runs on your own network today: the app and `sx-link` on the same machine, or a phone on the same network. Relaying it through SlicerX with end to end encryption to paired phones needs the relay service, which does not exist.

### If the picture does not show

1. The camera must work in the printer's own web page or Bambu Studio first.
2. Bambu Lab: check LAN Only Mode and the access code. X1 printers need port 322 open.
3. Klipper: the webcam must have an MJPEG stream URL. In Mainsail or Fluidd, set the webcam service to MJPEG-streamer.
4. Not listed above, or the address does not work: add it as an IP camera.

## For integrators

### Connector side (`sx_connect::camera`)

`PrinterSession::stream()` returns `Option<FrameStream>`: `CameraFrame { kind: Jpeg | H264, key, data }`, native quality, the connection closes when the stream is dropped. The default answers `None`. Implemented in `bambu`, `moonraker` (MJPEG, else polled stills), `octoprint`, `creality` (native), `elegoo` and `prusalink` (polled). H.264 is Annex B, one access unit per frame, with the SDP's SPS and PPS put in front of any key frame that lacks them.

`PrinterConfig` has three camera fields: `cameraUrl` (`rtsp://`, `rtsps://` or an `http://` MJPEG URL on the local network, refused when it has a user name in it), `cameraCredentialRef` (keychain entry holding `user:password`) and `rtspPort` (Bambu Lab, default 322). `camera::open_url(cfg, secrets)` opens `cameraUrl`; `sx-link` uses it in place of the connector when the config has one. ONVIF discovery and stream lookup are not implemented: the RTSP address has to be entered.

`sx_connect::rtsp` is a small RTSP client: TCP or TLS, Basic and Digest login, interleaved RTP, `sprop-parameter-sets`, keepalive, and H.264 depacketizing (single NAL, STAP-A, FU-A). It reads one H.264 video track. `camera::MjpegParser` splits multipart MJPEG by `Content-Length` when present.

### WebRTC signaling

`PrinterSession::webrtc_offer(sdp)` sends a browser's offer to the camera's service and returns the answer. Formats: camera-streamer `POST` JSON `{type, sdp}` (Moonraker webcam service `webrtc-camerastreamer`); WHEP `POST` `application/sdp` (`webrtc-mediamtx`, `webrtc-go2rtc`); Creality K2 `POST http://HOST:8000/call/webrtc_local`, `plain/text`, body base64 of `{"type":"offer","sdp"}`, answer likewise, from the K2 flow documented in the ha_creality_ws project. The K2 port is `cameraPort` when set. The offer must be video only and carry its ICE candidates, because every one of these is a single request and answer. Offers that are not SDP or exceed 64 KB are refused before anything is sent. `webrtc_answer(cfg, signaling, offer)` is the shared client.

### ONVIF (`sx_connect::onvif`)

`discover(target, window)` sends a WS-Discovery `Probe` for `NetworkVideoTransmitter` and reads the `ProbeMatches` (device service address, name and hardware scopes). `stream_uri(client, device_service, login)` runs `GetCapabilities` (media service), `GetProfiles` (first H.264 profile, else the first) and `GetStreamUri` with a WS-Security `UsernameToken` digest. The RTSP address the camera reports is used for its path only: the host is always the one the camera was reached at, and any login in it is dropped. Cameras that want HTTP digest login instead of the token are not supported. `cameraUrl` accepts `onvif://host[:port][/service-path]`; the same login is used for ONVIF and RTSP.

### Bridge side (`sx-link`)

| Method | Params | Result |
| --- | --- | --- |
| `camera.open` | `printerId`, `quality?` (`low`, `medium`, `high`, `auto`; default `auto`) | `{stream, quality, route: "lan"}`. Rejects with `not_supported` when the printer has no stream. At most four streams per connection. |
| `camera.quality` | `stream`, `quality` | `{quality}`. Sets the level and the ceiling automatic steps stay under. |
| `camera.close` | `stream` | `{closed}`. Streams also end when the connection closes. |
| `camera.webrtc` | `printerId`, `sdp` | `{sdp}`, the camera's answer. `not_supported` when the camera has no WebRTC service. |
| `cameras.discover` | `timeoutMs?` | `{cameras: [{host, port, name?, hardware?, cameraUrl}]}` from an ONVIF probe. `--no-mdns` turns it off. |
| `camera.probe` | `printerId`, `windowMs?` (500 to 5000) | `{ok, kind, firstFrameMs, fps, kbps, recommended}`. Reads the camera without streaming to the client. |

Frames are binary WebSocket messages, a 16 byte header and the payload: byte 0 `0xC1`, byte 1 kind (1 JPEG, 2 H.264), byte 2 bit 0 key frame, bytes 4 to 7 stream id (u32), bytes 8 to 15 bridge receive time in milliseconds since the epoch (u64), all big endian. Text events: `camera.stats` (`stream`, `fps`, `kbps`, `dropped`, `quality`, once a second) and `camera.ended`.

Adaptation is in `link/src/camera.rs`. JPEG frames are capped by quality. When more than 3 MB waits to be written, new frames are dropped, and for H.264 everything is dropped until the next key frame. A fifth or more dropped in a second lowers the quality one level; ten clean seconds raise it back up to the ceiling.

### Client side (`@slicerx/link-client`)

`host.camera.open(printerId, {quality})` gives a handle with `onFrame`, `onStats`, `onEnded`, `setQuality` and `close`. `linkCameraStreams(host)` returns the `CameraStreams` shape of `packages/app/src/camera/stream.ts`: it probes first, opens no higher than the probe recommends, decodes JPEG with `createImageBitmap` and H.264 with WebCodecs (`avc: {format: 'annexb'}`, `optimizeForLatency`), draws on a canvas and publishes it with `captureStream`. A host can expose it as `host.printers.streams`. `avcCodecString` derives the codec string from the SPS.

### Not done

- Relay for remote viewing, adaptive bitrate over a real network, and end to end encryption to paired phones. The frames are plain bytes on the loopback connection; sealing them for a phone belongs with the pairing layer (`packages/pair`), which sends what `pair.send` gives it. Remote viewing needs the relay service first.
- Audio, HLS webcams, ONVIF cameras that need HTTP digest login.
- WebRTC media through the bridge. It works where the browser can reach the printer; anything else uses frames.
- The canvas renderer and the WebRTC peer code have only run under test doubles, never in a browser, and none of this has seen a real camera. The K2, mediamtx and go2rtc request formats come from other projects' code and documentation, checked only against mocks that enforce the same format.

### Testing

`tests/camera.rs` runs every connector's stream against the mocks (`--camera` gives every mock printer a camera; the Bambu mock serves both the port 6000 JPEG stream and RTSPS with Digest login; `rtsp-camera` has a Basic login, `rtsp-open` none). `link/tests/link.rs` covers the bridge methods, and `link/src/camera.rs` the frame header and the drop and quality rules with a paused clock. `link-client/src/camera.test.ts` runs the real bridge, with a fake peer for WebRTC. The mocks add crowsnest, WHEP and K2 signaling on the Moonraker mock and an ONVIF camera (`onvif` with login, `onvif-open` without, `onvif-discovery` over UDP) in front of the RTSP mocks.
