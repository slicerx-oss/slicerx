# @slicerx/mock-printers

Protocol level fake printers for driver tests, driven by `../fixtures/demo-fleet.json`. Each fake is a small state machine (`src/machine.ts`) behind a real wire protocol: Moonraker (HTTP), PrusaLink, OctoPrint, Duet `rr_`, Elegoo SDCP (WebSocket and HTTP upload, hand written WebSocket framing), Creality stock firmware (WebSocket telemetry with heartbeat, `/info`, `/upload`, MJPEG), Snapmaker 2.0 (Luban HTTP API with a token that needs two status polls to be confirmed), Bambu Lab (MQTT over TLS, implicit FTPS, port 6000 camera, with a throwaway certificate made by `openssl` at start), Spoolman and Home Assistant.

Backing printers: Moonraker and Duet use Bay 4, PrusaLink Bay 3, OctoPrint Bay 2, Bambu Lab Bay 1 (with its AMS), Elegoo Bay 4, Creality Bay 5 (model `CR-K1 Max`), Snapmaker 2.0 Bay 2.

## Use

```
pnpm --filter @slicerx/mock-printers start -- [--only moonraker,bambu] [--state idle] [--auth]
```

Prints one JSON line with the ports (`ports`, `control`) and the throwaway credentials, then serves until stdin closes. `--state idle` forces every printer idle (lifecycle tests). `--auth` requires the mock API key and Duet password. `--digest` makes PrusaLink ask for HTTP digest login (user `maker`, password `mock-digest-pass`). The control server answers `GET /state` with each machine's state, uploaded files (with SHA-256) and request log, so tests can check what the printer actually received.

```ts
const mocks = await startMocks({ only: ['moonraker'], state: 'idle' })
mocks.ports.moonraker
await mocks.stop()
```

Credentials in here (`mock-api-key`, access code `12345678`, `mock-ha-token`) only open these fakes.

## Tests

`pnpm --filter @slicerx/mock-printers test`. The Rust suite in `packages/connect/tests` is the main consumer.
