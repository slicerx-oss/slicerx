# sx-cli

The `sx` command. Its JSON output is a public surface (`CHANGELOG.md`).

## Commands

```
sx slice <model> [--plate N] [--config <config.json>] [-o out.gcode | -o -] [--preview out.sxpv]
sx slice --request <req.json | -> [--out-dir <dir>]
sx schema [request | result]
sx metadata <project.3mf>
sx bench --config <bench.json> [--runs 15] [--warmup 3] [--threads N] [--json] [--no-shards]
         [--append results.jsonl] [--change "..."] [--write-baseline]
sx bench --config <bench.json> --ab <baseline sx> [--runs 15] [--threads N]
sx bench --config <bench.json> --incremental sparse_infill_density [--runs 15]
```

`sx slice <model>` writes the G-code to `-o`, or to stdout without it, so stdout carries nothing else. The one-line summary (layers, time, bytes, estimate, filament, tool changes) and warnings go to stderr.

`sx metadata` prints the settings a Bambu or Orca project carries (`projectSettings`, `modelSettings`, `layerRanges`, each only when present) as one JSON line, ready to pass to the settings crate's `import_project_json`.

`--plate` picks a plate of a Bambu or Orca 3MF project (the first plate by default).

`sx slice --request` reads a `SliceRequest` JSON (`sx schema request`) from a file or stdin and prints a result JSON with `schemaVersion` (`sx schema result`). An object's `mesh` is a key of the optional top-level `meshes` map (reference to file path) or a file path, relative to the request file. `file.3mf#2` picks plate 2 of a Bambu or Orca project (the first plate otherwise). Without a `transform`, the mesh is centered on the bed and set down on z = 0; a 3MF plate becomes one object per build item, placed as the file places them with the plate centered as a whole, so print by object sees each object. With `--out-dir`, the G-code and SXPV land there as `slice.gcode` and `slice.sxpv` and the result lists the paths under `files`.

Exit codes: 0 success, 1 slicing failed, 2 usage error, 3 invalid input (unreadable request or mesh, bad JSON or config).

`sx bench` runs the full pipeline (session preparation, slicing, G-code into memory, SXPV) on a bench config such as `../bench/configs/reference-0.20.json`, prints the median, p90, stage times and the correctness gates (layer count, the G-code validator, extrusion against `../bench/baseline-reference-0.20.json`, identical hashes for 1, 4 and 11 shards), and exits 1 when a gate fails. `--ab` alternates single invocations of a baseline binary and this one, for the hill-climb (`../bench/climb.mjs`).

## Dependencies

- `rayon` 1.12.0: sets the thread count for `--threads`.
- `serde_json` 1.0.151: the request, result and bench JSON.

## Status

All commands above work. Tests in `tests/request.rs` cover the request round trip from a file and from stdin, bad input (exit 3) and the schemas.
