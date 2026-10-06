# sx-connect

Printer and service plugins in Rust. One interface (`PrinterConnector`, `PrinterSession`, `ServicePlugin`), one manifest file (`manifests.json`, also served by `@slicerx/fleet-sim`), one approval gate for every call that changes something.

Subfolders:

- `link/`: `sx-link`, the localhost bridge for the browser build.
- `link-client/`: `@slicerx/link-client`, the TS `PrinterHost` that talks to `sx-link`.
- `sim/`: `@slicerx/fleet-sim`, the in-memory fleet for the browser demo and Pilot evals.
- `mock-printers/`: `@slicerx/mock-printers`, protocol level fakes the Rust tests run against.
- `catalog/`: `@slicerx/printer-catalog`, the brands and models first-run setup reads (see `docs/printer-catalog.md`).
- `fixtures/`: `demo-fleet.json`.

## Status per printer family

"Real protocol" means the driver speaks the documented wire protocol and passes the contract suite against the mock. None of it has been run against real hardware yet. Each driver README lists what is unverified.

| Plugin | Status | Notes |
| --- | --- | --- |
| Bambu Lab LAN (`bambu-lan`) | real protocol | MQTT over TLS, FTPS upload, AMS slots and mapping, camera on port 6000, SSDP search and announcements, hardware readout (nozzles per extruder, AMS units, firmware). X1, P1, A1 and H2D message shapes; discovery checked on a real H2D. |
| Moonraker (`moonraker`) | real protocol | HTTP API, polled events. |
| PrusaLink (`prusalink`) | real protocol | `/api/v1`, HTTP digest login as `maker`, `X-Api-Key` on firmware that takes one. |
| OctoPrint (`octoprint`) | real protocol | REST, polled events. |
| Duet (`duet`) | real protocol | RepRapFirmware `rr_` endpoints. |
| Elegoo (`elegoo`) | real protocol | Centauri Carbon over SDCP V3. Klipper models use the Moonraker plugin. |
| Creality (`creality`) | real protocol, two of them | Moonraker for Klipper models, and the native WebSocket interface Creality Print uses for stock K1, K1 Max, K1C, K2 Plus, Ender-3 V3 and Hi. Picked by probing. |
| Snapmaker (`snapmaker`) | real protocol, two of them | Moonraker for the U1, and the Luban HTTP API with touchscreen pairing for 2.0 machines (A150, A250, A350), found by a UDP 20054 broadcast. The J1 and Artisan (SACP) are found but not connected. |
| Anycubic (`anycubic`) | real protocol, experimental | LAN Mode: signed handshake on 18910, AES-128-CBC credentials, MQTT over TLS on 9883, with the client certificate only when the login alone is refused. Status, ACE slots, upload over `gcode_upload`, start, pause, resume, stop. Community sources only. |
| UltiMaker (`ultimaker`) | real protocol, experimental | Cura's local API: `_ultimaker._tcp` discovery, the cluster API for jobs, print cores and materials, the printer API for temperatures; optional touchscreen pairing for Digest. |
| Live camera | streams | See `docs/camera.md`. JPEG and MJPEG on most printers, H.264 over RTSPS on Bambu Lab X1 and H2, generic RTSP. Nothing has seen a real camera. |
| Spoolman (`spoolman`) | real protocol | Service plugin. |
| Home Assistant (`home-assistant`) | real protocol | Service plugin, allow-list of domains. |

## Public API

```rust
registry(gate: Arc<dyn ApprovalGate>) -> Vec<Box<dyn PrinterConnector>>
connector_for(gate, "moonraker") -> Option<Box<dyn PrinterConnector>>
all_manifests() -> Vec<PluginManifest>
```

Every `PrinterSession` method with a side effect (`upload`, `start`, `pause`, `resume`, `cancel`, `send_gcode`) takes an `&ApprovalToken` and calls `ApprovalGate::check(token, action, printer_id, params)` before it sends a byte. `params` is the canonical JSON (sorted keys, no whitespace) of the call's parameters, built by `sx_connect::params`: upload `{printerId, name, sha256}`, start `{printerId, name, opts}`, pause, resume and cancel `{printerId}`, G-code `{printerId, line}`, plugin tools `{pluginId, tool, input}`. A token for one target or parameter set fails for another. `Action::side_effect()` gives the broker's action name (`printer.upload`, `plugin.call`, and so on). `MemoryGate` is the in-process gate for tests. The app wraps its approval broker's `verify(token, action, target, sha256(params))` in the same trait.

Errors are `sx_connect::Error` with a `code()` that matches `PrinterErrorCode` in `packages/contracts/src/printers.ts`. Messages never contain credentials or URLs.

Connection log: set `SX_CONNECT_LOG` to a file path before starting the app or `sx-link`, and the Bambu Lab driver appends a line per connection event: each MQTT connection opened (address and client id), signed in and dropped (with the error), each session closed, and the `msg` type, key count and `ipcam` block of each status report. The camera path logs too, for any printer: the route chosen, each source opened (and for what: a probe, a live view, a still), TCP and TLS with the version or the error, each RTSP request with its status and the login scheme, the SDP's track, the first frame and first key frame with the codec string a decoder is set up with, why a stream ended, and each stream the bridge relays to a viewer. It is off by default and holds no access codes. `sx_connect::trace` writes it.

## Licensing of sources

The drivers are written from public protocol documentation and from the observable behavior of other clients. Where a source is under a different license (the Creality and Snapmaker references are AGPL-3.0), it was used for protocol facts only and no code was copied or translated; each driver README says so under "Source licenses".

## Security rules the code enforces

- Credentials come from `Secrets` (OS keychain through `KeychainSecrets`) and are never logged or returned. `Debug` output hides them.
- Bambu Lab printers present self-signed certificates, so those connections skip certificate validation but still verify handshake signatures. The LAN access code is the credential. Pinning the certificate on first use is a follow-up.
- Camera URLs that a printer reports must point at the printer's own host.
- Discovery runs only when the user starts a scan. It sends one SSDP search and listens for announcements (Bambu Lab), asks with one multicast DNS query (Moonraker, OctoPrint, PrusaLink, UltiMaker) or, for Elegoo and Snapmaker, sends one UDP broadcast, each out of every local network interface. See `docs/finding-printers.md`.
- `sx-link` only accepts printers on the local network (see `link/README.md`).

## Dependencies

Exact versions, reasons:

- `tokio`: async runtime for all I/O.
- `reqwest` (rustls, no provider, `ring` supplied by `rustls`): HTTP for Moonraker, PrusaLink, OctoPrint, Duet, Elegoo upload, Spoolman, Home Assistant.
- `rumqttc`: MQTT client for Bambu Lab.
- `rustls`, `tokio-rustls`: TLS for MQTT, FTPS and the camera stream. The `ring` provider avoids `aws-lc`, whose license is not on the `deny.toml` list.
- `tokio-tungstenite`: WebSocket client for Elegoo SDCP (and the server side of `sx-link`).
- `md-5`: SDCP upload checksum and HTTP digest login. `getrandom`: request ids and digest nonces.
- `keyring`: OS keychain.
- `serde`, `serde_json`, `thiserror`, `async-trait`, `futures`.

## Tests

```
cargo test -p sx-connect -p sx-link
pnpm --filter @slicerx/fleet-sim test
pnpm --filter @slicerx/mock-printers test
pnpm --filter @slicerx/link-client test   # needs target/debug/sx-link
```

The driver contract suite (`tests/common/mod.rs`, run by `tests/drivers.rs`) covers status, events, upload, start, pause, resume, cancel, wrong state, missing, forged, reused and mismatched tokens, G-code where the protocol has it, and the camera. It needs `node` on the PATH because the mocks are Node programs.

`UPDATE_FIXTURES=1 cargo test -p sx-connect --test contract_json` rewrites `packages/contracts/fixtures/printers-*.json` after an intentional wire change.

## First-run setup (`setup/`)

`@slicerx/connect` (`packages/connect/setup`) is the TypeScript layer first-run setup and mimir call: `createPrinterSetup(link)` returns `discover()` and `addPrinter()` (the two halves of `PrinterSetupHost` that belong to connect), `testConnection()` and `localPrinters()`. `link` is a `LinkHost` from `@slicerx/link-client`. `discover` maps the bridge's `discover` scan to `{id, name, family, address}` and can be canceled with an `AbortSignal`. `addPrinter` resolves `profileId` (a catalog model id, which is also the printer profile id in `@slicerx/settings`) through `@slicerx/printer-catalog`, stores the access code, key or password in the keychain under `printer-<id>` and registers the printer with the bridge; the credential is never in a return value or in the printer config. A printer with no connection is kept in `localPrinters()` for the host to save. `testConnection` calls the bridge's `printers.test`, which reaches, signs in, reads state and temperatures without registering anything. The bridge tests skip when `target/debug/sx-link` is not built, and use no credentials because the bridge writes to the real keychain.
