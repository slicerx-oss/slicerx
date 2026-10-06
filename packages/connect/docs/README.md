# Printer and service connectors

SlicerX talks to printers and to two home services through connectors that share one interface. Each guide below has two parts: what a person sets up on the printer, and what someone integrating or extending the connector needs to know.

| Guide | Covers |
| --- | --- |
| [bambu-lan.md](bambu-lan.md) | Bambu Lab X1, P1, A1 and H2D in LAN mode |
| [moonraker.md](moonraker.md) | Klipper printers with Moonraker |
| [creality.md](creality.md) | Creality K1, K1 Max, K1C, K2 Plus, Ender-3 V3 series and Hi, on stock firmware or Klipper |
| [snapmaker.md](snapmaker.md) | Snapmaker U1 and Snapmaker 2.0 (A150, A250, A350); J1 and Artisan are found but not connected |
| [prusalink.md](prusalink.md) | Prusa printers with PrusaLink (MK4S, MK3.9, MINI+, XL, Core One) |
| [octoprint.md](octoprint.md) | OctoPrint servers |
| [duet.md](duet.md) | Duet boards running RepRapFirmware 3 |
| [elegoo.md](elegoo.md) | Elegoo Centauri Carbon (SDCP) |
| [ultimaker.md](ultimaker.md) | UltiMaker S series and UM3 (experimental) |
| [camera.md](camera.md) | Live camera video: what each printer gives, quality, and the stream protocol |
| [export.md](export.md) | Printers with no supported connection: save G-code and carry it over |
| [finding-printers.md](finding-printers.md) | How scanning finds printers, what it sends, and what to do when it finds nothing |
| [printer-catalog.md](printer-catalog.md) | The catalog of brands and models that first-run setup reads |
| [spoolman.md](spoolman.md) | Spoolman filament inventory |
| [home-assistant.md](home-assistant.md) | Home Assistant power plugs, lights and fans |
| [real-printer-checklist.md](real-printer-checklist.md) | What to run on real hardware before a connector is called working |

## Setting up your first printer

1. Pick your printer from the catalog, or search for it. The catalog knows the model's build volume, nozzle sizes and how it connects.
2. Follow the guide for that connection. Each one lists, screen by screen, where to read the IP address and the access code or key on the printer itself.
3. Choose Scan to let SlicerX find it, or enter the IP address. See [finding-printers.md](finding-printers.md).

All screen names in these guides come from the printers' documentation. None has been read off a printer yet, and menus move between firmware versions.

## How connectors behave

- Everything stays on your network. A connector talks straight to the printer, or to Spoolman or Home Assistant on your LAN. No printer traffic goes through a SlicerX server. Printers and service URLs must be on the local network (private addresses, `.local` names).
- Reading is free, changing needs approval. Status, temperatures, filament slots and camera frames are read without asking. Uploading a file, starting, pausing, resuming, canceling, sending G-code and changing inventory or home devices each need an approval you give in the app. An approval covers one action on one printer with the exact parameters shown to you, and it is used up when it is spent.
- Credentials (access codes, API keys, passwords, pairing tokens) are stored in your operating system keychain. They are never written to logs, never shown again and never sent to the model.
- Scanning is user started. See [finding-printers.md](finding-printers.md) for what each scan sends.
- Printers that go offline show as offline. They do not raise errors in the printers list.

None of these connectors has been run against a physical printer yet. Each guide has an "Untested on hardware" section that lists what to check first if something does not behave.

## Capabilities at a glance

| Connector | Status | Events | Upload | Start, pause, resume, cancel | Camera | Filament slots | G-code console |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Bambu LAN | yes | push | yes | yes | A1 and P1 | AMS | yes |
| Moonraker | yes | polled | yes | yes | if a webcam is configured | no | yes |
| PrusaLink | yes | polled | yes | yes | if a camera is configured | no | no |
| OctoPrint | yes | polled | yes | yes | if a webcam is configured | no | yes |
| Duet | yes | polled | yes | yes | no | no | yes |
| Creality (stock) | yes | push | yes | yes | K1, Ender, Hi | no | yes |
| Snapmaker 2.0 | yes | polled | yes | yes | no | no | yes |
| Elegoo Centauri Carbon | yes | push | yes | yes | yes | no | no |

## For integrators

### The interface

Rust crate `sx-connect`. A `PrinterConnector` opens a `PrinterSession` for one printer. Sessions expose `status`, `events`, `upload`, `start`, `pause`, `resume`, `cancel`, `snapshot` and `send_gcode`. Service plugins (Spoolman, Home Assistant) implement `ServicePlugin::call(tool, args, token)`. The TypeScript side is `PrinterHost` in `@slicerx/contracts`. Browsers reach real printers through `sx-link`, a localhost bridge, using `@slicerx/link-client`. `@slicerx/fleet-sim` implements the same `PrinterHost` in memory for demos and tests.

### Plugin manifest

Every plugin has a manifest (`manifests.json` is the single source for the Rust crate and the simulator):

```json
{
  "id": "moonraker",
  "name": "Moonraker (Klipper)",
  "version": "0.1.0",
  "kind": "printer",
  "protocols": ["http", "websocket-jsonrpc"],
  "capabilities": ["status", "events", "upload", "start", "pause", "resume", "cancel", "camera", "gcode_console"],
  "tools": [{ "name": "moonraker.status", "permission": "read", "description": "...", "inputSchema": { "type": "object" } }],
  "network": ["lan:7125", "lan:80", "lan:443"]
}
```

`tools` are what Pilot may call. Their `permission` is `read`, `queue` (upload), `start` (heat or move a printer, or control a job) or `profile` (change inventory). `network` lists the hosts and ports the plugin may reach; `lan:` means the local network only.

### Normalized status

`state` is one of `idle`, `preparing`, `printing`, `paused`, `finished`, `error`, `offline`. Also job name, progress (0 to 1), layer and layer count, time left in seconds, nozzle, bed and chamber temperatures (current and target), filament slots (id, material, color, remaining percent), camera availability and a message.

### Approvals

Calls that change something take an approval token. Pairing a printer that needs a tap on its own screen (Snapmaker 2.0) is not one of them; it changes nothing on the printer. The connector checks it through an `ApprovalGate` before sending any byte. The check receives the action (`printer.upload`, `printer.start`, `printer.pause`, `printer.resume`, `printer.cancel`, `printer.gcode`, `plugin.call`), the target (printer or plugin id) and the canonical JSON of the parameters: upload `{printerId, name, sha256}`, start `{printerId, name, opts}`, pause, resume and cancel `{printerId}`, G-code `{printerId, line}`, plugin tools `{pluginId, tool, input}`. A token for one action, target or parameter set fails for another and works once.

### Errors

Every failure has a code: `unreachable`, `auth`, `not_supported`, `approval_required`, `approval_invalid`, `not_found`, `bad_state`, `protocol`. Messages never contain credentials or URLs.

### Events

Sessions expose a stream of `status`, `job_finished` and `error` events. Bambu Lab, Elegoo and stock Creality push. The others poll every `pollMs` milliseconds (default 1000, minimum 50) and emit only when something other than the timestamp changed. A job is reported finished when a printing or paused printer becomes finished, or becomes idle after reaching at least 98 percent.

### Testing against the mocks

`@slicerx/mock-printers` runs fakes for every protocol, driven by `demo-fleet.json` (Bay 1 X1 Carbon with AMS, Bay 2 P1S with AMS, Bay 3 MK4S, Bay 4 Voron 2.4 350, Bay 5 K1 Max offline). Start them with `pnpm --filter @slicerx/mock-printers start -- --state idle`; it prints ports and throwaway credentials as JSON. `cargo test -p sx-connect` starts the mocks itself and runs the driver contract suite: status, events, upload, start, pause, resume, cancel, wrong state, missing, forged, reused and mismatched tokens, G-code and camera. `pnpm --filter @slicerx/fleet-sim test` runs the same checks against the in-memory host.

### Adding a printer family

1. Add a manifest to `manifests.json`.
2. Implement `PrinterConnector` and `PrinterSession` under `src/drivers/<name>/`. Call the gate first in every method that changes something. Map the printer's states onto the normalized ones. Use `poll_events` when the protocol has no push channel.
3. Register it in `drivers::all`.
4. Write a fake in `mock-printers/src/<name>.ts` that speaks the real protocol on top of `MockMachine`, and add it to `startMocks`.
5. Add a case to `tests/drivers.rs`. The contract suite in `tests/common/mod.rs` does the rest.
6. Write the guide for it here, with the protocol's public documentation as sources.

If the printer runs Klipper and Moonraker, skip steps 2 to 5: wrap `MoonrakerConnector::for_plugin(id, default_port, gate)`. The Creality and Snapmaker connectors do that and add a second protocol, chosen by probing (`PrinterConfig.protocol` overrides the probe). Printers that need pairing implement `PrinterConnector::authorize`.
