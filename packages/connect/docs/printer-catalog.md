# Printer catalog

`@slicerx/printer-catalog` (`packages/connect/catalog`) is the data that first-run setup reads: which brands and models exist, how each one moves, how big it is, which nozzles it takes, how SlicerX connects to it and where a person finds the IP address and the code on the printer. It is plain typed data with no runtime dependencies, so the studio, the phone apps and Pilot read the same file.

## For users

You never open the catalog. It is the list you pick from when you add a printer. Picking a model fills in the build volume and nozzle sizes, chooses the best connection, and shows the steps for finding your printer's address and code. If your printer is not listed, pick Klipper printer, Printer behind OctoPrint, Duet board or Printer without a connection, and set the size yourself.

## For integrators

```ts
import { PRINTER_MODELS, modelById, connectionsFor, preferredConnection, searchModels } from '@slicerx/printer-catalog'

const a1 = modelById('bambu-a1')!
a1.buildVolume            // { shape: 'rectangular', x: 256, y: 256, z: 256 }
preferredConnection(a1)   // the ConnectionMethod for 'bambu-lan'
a1.find.credential        // where to read the access code on the printer
```

### Model

`id`, `brand`, `name`, `kinematics` (`bed-slinger`, `cartesian`, `corexy`, `corexz`, `delta`, `idex`, `toolchanger`), `enclosed`, `buildVolume` (rectangular, or circular with the origin at the center), `nozzles`, `defaultNozzle`, `nozzleCount`, `filamentSystem`, `connections`, `find`, an optional `note` and an optional `webUi`. `KINEMATICS_LABELS` has the display names. The catalog has no icon fields: the UI maps `kinematics` and `filamentSystem` to the generic icons and picks brand marks from `@slicerx/brand-icons`.

### Connections

Each method also lists `startOptions`: the print options it sends with a start (`bedLeveling`, `flowCalibration`, `vibrationCompensation`, `timelapse`, `firstLayerInspection`). Bambu Lab sends all five, Elegoo sends two, the rest none, so the UI shows only what a connection uses.


`connections` is best first and ends in `export` (save G-code) for every model, so the setup screen always has something to offer. Each id resolves through `connectionMethod(id)` to a `ConnectionMethod`: the plugin id in `manifests.json`, the guide file in `docs`, the default port, how it can be discovered, and the fields the add-printer form asks for, with `secret` marking what goes to the keychain. `pairsOnPrinter` marks Snapmaker 2.0, which asks for a tap on its touchscreen.

### Web pages

Printers that serve their own web page get an "Open web interface" item in the printer menu, the live view and the phone's printer screen, which opens the page in the browser. `ConnectionMethod.webUi` is where a connection's printers serve it: Mainsail or Fluidd on port 80 for Moonraker, and OctoPrint, PrusaLink and Duet Web Control on the connection's own server (`sharesPort`, so a port saved with the printer moves the page too; with none saved, the connection's default port). A model's `webUi` comes first when the page is somewhere else: QIDI's Fluidd on 10088, a Creality K2's Fluidd on 4408, and a K1's on 4408 once Moonraker is installed (`via: ['moonraker']`, so the stock connection gets no link). Connections with no page (Bambu Lab, Anycubic, Elegoo's own, Snapmaker's own, UltiMaker, BamBuddy) give none.

`printerWebUi(printer)` builds the address from the saved printer, never from typed text, and only for a host on the local network: a private, loopback or link-local address, or a `.local`, `.lan`, `.home.arpa` or single-label name, the rule the bridge applies before it connects a printer. A name a browser reads as an IPv4 number (`134744072`, `0x08080808`) and an address with a leading zero (read as octal) are refused, since a browser would open a public address for them. Both rules are tested against `fixtures/lan-hosts.json`. The link also refuses a single label that is a root-zone top-level domain (`ai`, `com`, `studio`; the list is `catalog/src/root-tlds.ts`), since such a name can resolve on the internet; the bridge still connects to it. The address is written as a browser writes it (lower case, short IPv6). A page on the connection's own server is https when the connection uses TLS. A printer reached through a tunnel gets no link, and neither does a phone that reaches the computer through the relay: away from home the local address would open on whatever network the phone is on, so the phone shows "Available on your home network" instead, and mimir there offers no link. The desktop shell checks the address again before it opens the browser.

### Find guides

`model.find` holds the sentences the setup screen shows: `ip`, `credential` and `serial` where they apply. `checkedOnPrinter` is false for every entry, because the wording follows vendor documentation and nobody has read it off a printer. Set it to true, and fix the sentence, when someone has.

### Settings profiles

The catalog holds no profile links. `@slicerx/settings` maps a catalog model id to its printer profile (`printerProfile`, `printerForModel`), so the id is a key other packages depend on: tell settings before renaming one.

### Adding a model

1. Add it to the brand's file in `catalog/src/models/`. Copy a neighbor.
2. Use only connections that exist in `methods.ts`. If the printer needs a new connection, add the connector first (see the README in this folder).
3. Add the model to `packages/settings/scripts/printer-specs.json` (flavor and the maker's page) and run `node scripts/gen-profiles.mjs` in `packages/settings`.
4. `pnpm --filter @slicerx/printer-catalog test`. It checks the shape, the connectors, the guide files and the demo fleet. The settings tests check that every model has a profile.

### Sources

Build volumes and nozzle sizes come from each maker's published specifications. They describe the stock machine. A modified printer needs its own numbers.
