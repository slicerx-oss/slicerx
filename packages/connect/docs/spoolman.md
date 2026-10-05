# Spoolman

Reads your filament inventory from a Spoolman server (materials, colors, remaining grams) and can subtract used filament from a spool.

## For users

### On the server

1. Run Spoolman (Docker or a standalone install) on a machine on your network. It listens on port 7912 by default.
2. Add your spools in its web page.
3. Note the server address, for example `http://192.168.1.50:7912`.

### In SlicerX

1. Connect the printer bridge: Settings, Printer bridge (the desktop app connects by itself).
2. Under Spoolman, type the address in the field (for example `192.168.1.50`; SlicerX adds `http://` and Spoolman's port 7912 when you leave them out) and click Add Spoolman.
3. SlicerX tests it right away. "Connected" with the number of spools means it works. Test connection checks again later, and Remove Spoolman forgets the server.

The address must be a plain `http://` address on your local network; `https://` addresses and addresses with a path are refused. The bridge keeps the address across restarts.

What SlicerX does with it: in the Filament dialog you pick a spool for each filament slot and see the grams left, Print warns when a linked spool holds less than the plate needs, and after a print it offers to record the filament used ("Record use in Spoolman"). Reading needs no approval. Recording use asks first, and each approval covers one spool and one amount; mimir asks the same way.

### Common problems

| Message or symptom | Cause and fix |
| --- | --- |
| "Spoolman did not answer at that address" | Wrong address or port, or the server is off. |
| "Use the plain http:// address of Spoolman on your network" | Type the `http://` address, not `https://`. |
| A spool is missing | Archived spools are hidden unless requested. |
| The approval for recording use is refused | The approval covers exactly one spool and gram amount; ask again with the amount you want. |

### Untested on hardware

Checked against a simulator of the Spoolman API, not a server. First thing to check: the `use` endpoint on your Spoolman version.

## For integrators

Plugin id `spoolman` (kind `inventory`). The hub stores its address with `services.configure {pluginId, baseUrl}`, lists it with `services.list` (address and `hasSecret`, never a secret) and forgets it with `services.remove {pluginId}`; all three are for the app connection only. Tools: `spoolman.list_spools` (read; `material`, `includeArchived`), `spoolman.get_spool` (read; `id`), `spoolman.record_usage` (permission `profile`; `id`, `grams`; needs a `plugin.call` approval bound to `{pluginId, tool, input}` with the tool name `record_usage`). Network: `lan:7912`, `lan:8000`.

Spools are normalized from Spoolman's shape to `{id, material, vendor, name, color, remainingG, initialG}` with `color` as `#rrggbb`. Filament slots in printer status can carry a `spoolmanId` so a slot links to a spool.

Requests: `GET /api/v1/spool?allow_archived=false`, `GET /api/v1/spool/{id}` and `PUT /api/v1/spool/{id}/use` with `{"use_weight": grams}`. Nothing is cached and there is no rate limit beyond your server's.

### Testing

`tests/services.rs` runs the plugin against a Spoolman fake. `@slicerx/fleet-sim` serves the same tools from `demo-fleet.json` (nine spools) through `callTool('spoolman', ...)`.

### Sources

Spoolman: https://donkie.github.io/Spoolman/ (OpenAPI at `/api/v1/docs` on your server).
