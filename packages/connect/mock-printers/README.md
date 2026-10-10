# @slicerx/mock-printers

Protocol level fake printers for driver tests, driven by `../fixtures/demo-fleet.json`. Each fake is a small state machine (`src/machine.ts`) behind a real wire protocol: Moonraker (HTTP), PrusaLink, OctoPrint, Duet `rr_`, Elegoo SDCP (WebSocket and HTTP upload, hand written WebSocket framing), Creality stock firmware (WebSocket telemetry with heartbeat, `/info`, `/upload`, MJPEG), Snapmaker 2.0 (Luban HTTP API with a token that needs two status polls to be confirmed), the Snapmaker U1 (the Moonraker fake as a U1, with a webcam), Bambu Lab (MQTT over TLS, implicit FTPS, port 6000 camera, with a throwaway certificate made by `openssl` at start), Spoolman and Home Assistant.

Backing printers: Moonraker and Duet use Bay 4, PrusaLink Bay 3, OctoPrint Bay 2, Bambu Lab Bay 1 (with its AMS), Elegoo Bay 4, Creality Bay 5 (model `CR-K1 Max`), Snapmaker 2.0 Bay 2, Snapmaker U1 Bay 4.

## Use

```
pnpm --filter @slicerx/mock-printers start -- [--only moonraker,bambu] [--state idle] [--auth]
```

Prints one JSON line with the ports (`ports`, `control`) and the throwaway credentials, then serves until stdin closes. `--state idle` forces every printer idle (lifecycle tests). `--auth` requires the mock API key and Duet password. `--digest` makes PrusaLink ask for HTTP digest login (user `maker`, password `mock-digest-pass`). The control server answers `GET /state` with each machine's state, uploaded files (with SHA-256) and request log, so tests can check what the printer actually received. It also has the running `job`, the `faults` in force and the `camera` frame. `--tick` moves printing jobs on by themselves (36 s of print a second); without it a job moves only when asked (`POST /tick`).

```ts
const mocks = await startMocks({ only: ['moonraker'], state: 'idle' })
mocks.ports.moonraker
await mocks.stop()
```

Credentials in here (`mock-api-key`, access code `12345678`, `mock-ha-token`) only open these fakes.

## Shared controls

These take the same body on every brand, so one test can run against each (`mock` is the name in `ports`):

- `POST /camera {mock, frame}`: what the camera sends from now on. `frame` is `placeholder` (a tiny JPEG), `hand` (`HAND_FRAME`, a hand reaching into the printer, for the camera guard) or the path of a JPEG file, read for each frame. Works on `prusalink` (the snapshot), `elegoo` (the MJPEG stream Cmd 386 names, a frame every 100 ms until the client closes), `snapmaker-u1` and `moonraker` (the webcam snapshot and stream) and `bambu` (the port 6000 stream; `POST /bambu {cameraFrame, cameraFrameFile}` still works). The Snapmaker 2.0 has no camera, so it answers 400.
- `POST /fault {mock, kind}`: `runout`, `door`, `offline`, or `clear` to end them all. A runout pauses a running print; clearing it leaves the print paused for a resume. Offline remembers the state and clearing it brings it back. Each is logged (`fault runout`, `fault clear`). Mocks without faults (Bambu among them) answer 400.
- `POST /tick {mock, seconds}` moves a printing job on by that much now (progress, layer, time left; it finishes at zero); `{mock, everyMs, seconds}` does it on a timer (`everyMs: 0` stops).

What each fault looks like:

| Mock | runout | door | offline |
| --- | --- | --- | --- |
| `prusalink` | `ATTENTION`, with the message in `status_printer` | not a Prusa concept: logged only | one 503, then connections refused |
| `elegoo` | paused as by a pause command (`CurrentStatus` 1, `PrintInfo.Status` 10); SDCP V3.0.0 has no runout code, so this stands in until the real one is known | logged only (no door in SDCP V3.0.0) | the WebSocket drops, reconnects refused |
| `snapmaker-luban` | `isFilamentOut: true`, print paused | `isEnclosureDoorOpen: true` | requests get no answer until the client gives up |
| `snapmaker-u1` | print paused, first toolhead's `filament_exist` false | logged only | connections refused |

The PrusaLink fake also reports axis positions (X and Y only while the head is still), fan, speed and flow in its status, the file's layer height, top layer Z and estimate in its job, a 404 for another job id, a 409 for pause or resume in the wrong state, and a 409 for an upload while another is landing (`POST /slow` makes uploads take time). The Elegoo fake pushes a status report after every change and once a second while printing.

## Snapmaker U1

`snapmaker-u1` is the Moonraker fake started as a U1: host name `U1`, the U1's `print_task_config` and `filament_detect` objects (four toolheads), and one webcam in `/server/webcams/list` whatever the fixture says. The driver finds it as plugin `snapmaker` on Moonraker. `--auth` asks it for the mock API key too.

## Tests

`pnpm --filter @slicerx/mock-printers test`. The Rust suite in `packages/connect/tests` is the main consumer.
