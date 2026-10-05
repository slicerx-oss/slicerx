# Print farm example

A small tool that slices every model in a folder and writes G-code and a preview for each one. It can keep watching the folder, and it can queue the results on a printer through the SlicerX hub. It shows the two ways to drive the engine from your own software:

- the `sx` command line tool with a JSON request (`src/slice.ts`)
- the C ABI, `libslicerx` (`c/farm_slice.c`)

Use it as a starting point. It is short and has no dependencies beyond Node and the SlicerX packages in this repository.

## Requirements

- Node 24 or later (it runs the TypeScript sources directly)
- Rust (the version in `rust-toolchain.toml`) to build `sx` and `libslicerx`
- A C compiler, only for the C ABI example

From the repository root:

```sh
cargo build --release -p sx-cli          # builds target/release/sx
pnpm install                             # only needed for --queue
```

## Slice a folder

```sh
node examples/farm/src/farm.ts ~/models --out ~/farm-out --sx target/release/sx
```

For every `.stl`, `.3mf` and `.obj` file directly in `~/models`, the tool writes a folder named after the model:

```
~/farm-out/gear/
  request.json   the SliceRequest sent to sx (see `sx schema request`)
  slice.gcode    the G-code (slice.bgcode when the config asks for binary G-code)
  slice.sxpv     the toolpath preview, which @slicerx/viewport draws
  result.json    layers, print time, filament, warnings (see `sx schema result`)
```

It prints one line per model, for example `test-cube: 50 layers, 0 h 12 min, 2.0 g, 325 KB of G-code, sliced in 39 ms`. A model is sliced again only when its file is newer than its `result.json`, so running the tool twice skips work already done. A model that fails to slice is reported and the exit code is 1; the others still run.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `--out <dir>` | `farm-out` | Where the per-model folders go |
| `--config <file>` | none | Settings as JSON by OrcaSlicer key, for example `{"layer_height": 0.2, "wall_loops": 3, "sparse_infill_density": 20}`. Keys left out take the SlicerX defaults. |
| `--bed <w>x<d>x<h>` | `256x256x250` | Bed size in mm |
| `--flavor <name>` | engine default | G-code flavor, as OrcaSlicer names it: `marlin2`, `klipper`, `bambu`, `reprapfirmware` and others |
| `--sx <path>` | `$SX_BIN`, else `sx` on the PATH | The sx binary |
| `--watch` | off | Keep running and slice models as they are added or changed |
| `--queue <printer id>` | off | Queue the sliced plates on this printer through the hub (below) |
| `--hub <url>` | `ws://127.0.0.1:47615` | The hub's address |
| `--hub-key <base64>` | none | The hub's public key, to check that the hub is the real one before the code is sent |

With `--watch`, a file that is still being copied in is left until its size stops changing.

## Queue plates on a printer

The hub (`sx-link`, see `packages/connect/link/README.md`) holds a queue per printer. The tool connects with the hub's app code, which it reads from `SX_LINK_CODE` so the code stays out of your shell history:

```sh
export SX_LINK_CODE=ABCD-EFGH                   # printed by `sx-link code` on the hub machine
node examples/farm/src/farm.ts ~/models --sx target/release/sx --queue bay-4
```

After slicing, the tool lists the plates and asks once at the terminal before it queues anything. The default answer is no, and with no terminal attached (a cron job, a pipe) it never queues. A queued plate does not start on its own. When its turn comes, the hub raises an approval card in the SlicerX app, and the print starts only after a person approves it there and confirms that the bed is clear. The printer id is the one shown in the app's printer list.

The queue call is in `src/queue.ts` (`queuePlates`). It sends each G-code file with its SHA-256, which the hub checks before anything reaches the printer.

## The C ABI

`c/farm_slice.c` does the same job for one model through `libslicerx`: load the mesh with `sx_mesh_load`, pass a SliceRequest to `sx_slice`, and write the G-code, preview and result JSON from the returned buffers.

```sh
sh examples/farm/c/build.sh                                     # builds libslicerx and target/release/farm_slice
target/release/farm_slice ~/models/gear.stl ~/farm-out/gear config.json
```

The header is `packages/core/ffi/include/slicerx.h`, and `packages/core/ffi/README.md` lists every call. Every buffer the library returns is freed with `sx_buffer_free`, and every result with `sx_result_free`.

## Tests

```sh
pnpm --filter @slicerx/farm-example test        # unit tests; add SX_BIN=target/release/sx to slice the test cube too
pnpm --filter @slicerx/farm-example typecheck
sh examples/farm/scripts/smoke.sh               # builds sx and libslicerx, slices the test cube both ways, compares
```

The smoke script copies the test cube from `packages/core/cli/tests/fixtures/cube.stl` into a temporary folder, runs the farm tool and the C example on it, checks that each wrote G-code, an SXPV preview and a result, and checks that both report the same layer count.
