# sx-cli

The `sx` command. Its JSON output is a public surface (`CHANGELOG.md`).

## Commands

```
sx slice <model> [--plate N] [--config <config.json>] [-o out.gcode | -o -] [--preview out.sxpv]
sx slice --request <req.json | -> [--out-dir <dir>]
sx schema [request | result]
sx metadata <project.3mf>
sx project-settings <project.3mf>
sx call [server options] <tool> [json] [<tool> [json] ...]
sx remap-toolheads <in.gcode> --map <logical=physical,...> -o <out.gcode> [--json]
sx bench --config <bench.json> [--runs 15] [--warmup 3] [--threads N] [--json] [--no-shards]
         [--append results.jsonl] [--change "..."] [--write-baseline]
sx bench --config <bench.json> --ab <baseline sx> [--runs 15] [--threads N]
sx bench --config <bench.json> --incremental sparse_infill_density [--runs 15]
```

`sx slice <model>` writes the G-code to `-o`, or to stdout without it, so stdout carries nothing else. The one-line summary (layers, time, bytes, estimate, filament, tool changes) and warnings go to stderr.

`sx metadata` prints the settings a Bambu or Orca project carries (`projectSettings`, `modelSettings`, `layerRanges`, each only when present) as one JSON line, ready to pass to the settings crate's `import_project_json`.

`sx project-settings` prints the settings `sx slice <project.3mf>` takes from a project as one JSON object on stdout, ready to pass as a request's `config`: the project's own values, the engine choices it did not change, our defaults for keys it does not set, and the reading of keys it lacks by the app that wrote it (a Bambu Studio project without them gets `wipe_tower_wall_type` rib, `initial_layer_travel_acceleration` 500 and `internal_bridge_speed` 100%). A 3MF without settings prints `{}`. The walls and the engine choices kept go to stderr.

`sx remap-toolheads` moves the logical tools of a sliced Snapmaker U1 file onto other physical toolheads (0 to 3) with the printer bridge's toolhead rewrite: `T`, the `T` of M104, M109, M116 and M900, `INDEX=` on `SM_PRINT_PREEXTRUDE_FILAMENT` and `SM_PRINT_FLOW_CALIBRATE`, and `EXTRUDER=extruderN`. Comments, `A0` references and the input file stay as they are, and every tool the file selects must be in the map. It prints the map, the changed lines by kind and the output's SHA-256; with `--json`, one object with `output`, `sha256`, `sourceSha256`, `bytes`, `map`, `toolsUsed`, `unusedMapTools` and `counts` (`changedLines`, `toolChanges`, `temperatures`, `preextrudeIndexes`, `flowCalibrateIndexes`, `extruderNames`). A file the rewrite refuses exits 3 and writes nothing; with `--json` stdout carries `{"version":1,"error":"remap_refused","line":N,"reason":"..."}` (`line` is null when the whole file or the map is refused). A bad `--map` or a missing `-o` exits 2.

`--plate` picks a plate of a Bambu or Orca 3MF project (the first plate by default).

`sx slice --request` reads a `SliceRequest` JSON (`sx schema request`) from a file or stdin and prints a result JSON with `schemaVersion` (`sx schema result`). An object's `mesh` is a key of the optional top-level `meshes` map (reference to file path) or a file path, relative to the request file. `file.3mf#2` picks plate 2 of a Bambu or Orca project (the first plate otherwise). Without a `transform`, the mesh is centered on the bed and set down on z = 0; a 3MF plate becomes one object per build item, placed as the file places them with the plate centered as a whole, so print by object sees each object. With `"plate": {"placement": "keep"}` (the default is `"center"`) the items stay where the file's build transforms put them, from the front left corner of the `printable_area` (80, 100 in the file is 80.5, 101 on the Snapmaker U1), with no recentering; a Bambu Studio, OrcaSlicer or PrusaSlicer project keeps its own positions under either. With `keep`, a part that lands off the printable area (the config's `printable_area`, else the plate `bed` from 0, 0) is refused with exit 3 and a message naming each part and how far it reaches past each edge, such as `Object_1 is 5 mm past the right edge of the printable area (X 0 to 270, Y 0 to 270 mm) where the file places it`. An STL or OBJ has no placement of its own, so it is centered under `keep` too. With `--out-dir`, the G-code and SXPV land there as `slice.gcode` and `slice.sxpv` and the result lists the paths under `files`. A request takes its `config` as given; with `"options": {"projectDefaults": true}`, the keys it lacks that the app that wrote the first project file the plate names reads its own way are filled in first, as `sx slice <project.3mf>` fills them, and stderr names them. A request whose config carries no printer settings at all (no `printable_area` or `bed_shape`, no `machine_max_` or `machine_min_` keys) still slices, exit 0, on the engine's defaults, which no real printer has; the result then has a `no_machine_profile` warning in `warnings` and `configReport.warnings`, and stderr says so. A plate `bed` alone is not printer settings: send the printer's config (from `slicerx_get_profile` with a `machine:` profile, or `sx project-settings` for a project).

Exit codes: 0 success, 1 slicing failed, 2 usage error, 3 invalid input (unreadable request or mesh, bad JSON or config).

`sx bench` runs the full pipeline (session preparation, slicing, G-code into memory, SXPV) on a bench config such as `../bench/configs/reference-0.20.json`, prints the median, p90, stage times and the correctness gates (layer count, the G-code validator, extrusion against `../bench/baseline-reference-0.20.json`, identical hashes for 1, 4 and 11 shards), and exits 1 when a gate fails. `--ab` alternates single invocations of a baseline binary and this one, for the hill-climb (`../bench/climb.mjs`).

## Tool commands

`sx call` runs the same commands as `slicerx-mcp call`, using the installed `@slicerx/mcp` runtime and Node.js 24 or newer. Calls run in order in one process, so a design created by one call is available to the following calls. Each result is one JSON line with `tool`, `ok`, `text` and `output`; the runtime's exit status and errors pass through unchanged. The runtime enforces the same permissions and approvals as MCP.

```sh
sx call --no-app design_new '{"name":"Bracket"}' \
  geom_extrude '{"design":"d1","shape":{"type":"rectangle","widthMm":20,"heightMm":10},"distance_mm":3}' \
  design_steps '{"design":"d1"}' geom_info '{"design":"d1"}'
sx call --app design_list
```

Use `--app` for the project open in the app through its enabled app link. Use design ids from `design_list` and read the resulting history, parts and volume with `design_steps`. Server options such as `--allow-dir`, `--policy`, `--printers` and `--out-dir` pass to the runtime.

The runtime is found in the nearest `node_modules/@slicerx/mcp` above the working directory, then beside `sx` as `slicerx-mcp.mjs` or in a package install above the executable. `SLICERX_MCP_CLI` selects an explicit built entry file; an invalid override fails without falling back. `SLICERX_NODE_BIN` selects Node.js, otherwise `node` comes from `PATH`. Nothing is installed or downloaded by this command.

Unless explicitly configured, tool calls use this `sx` executable for slicing and a neighboring `sx-geom` executable for geometry. `sx call --help` works without the tool runtime installed. An empty call is a usage error (exit 2); a missing runtime or Node.js is exit 1.

## Dependencies

- `rayon` 1.12.0: sets the thread count for `--threads`.
- `serde_json` 1.0.151: the request, result and bench JSON.
- `sx-connect` (this workspace): the toolhead rewrite of the printer bridge, for `sx remap-toolheads`.

## Status

All commands above work. Tests in `tests/request.rs` cover the request round trip from a file and from stdin, bad input (exit 3) and the schemas.
