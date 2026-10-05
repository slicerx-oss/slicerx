# sx-core

The SlicerX slicing engine in Rust Apache-2.0: mesh loading, the slicing pipeline, G-code with time and filament estimates, and SXPV preview buffers. It takes bytes and returns bytes, with no filesystem, networking or async runtime, so the same code runs natively and in WebAssembly. Per-layer parallelism uses rayon behind the default feature `parallel`, which the WASM build turns off.

Folders:

- `src/`: the engine (`sx-core`).
- `wasm/`: `sx-wasm`, the module the browser worker pool loads.
- `web/`: `@slicerx/slicer`, the browser worker pool.
- `cli/`: `sx-cli`, the `sx` command.
- `ffi/`: `sx-ffi`, `libslicerx` for C and other languages, with `include/slicerx.h`.
- `bench/`: the reference model, bench configs, the native and browser harnesses and their logs.
- `benches/`: criterion benches per stage.
- `tests/`: the reference model test (layer count, G-code validator, shard hashes, golden hashes).

## Public API

Embedders use `sx_core::api`, the only module covered by semver (`CHANGELOG.md`). The crate root re-exports the same items for the workspace's own crates; other modules are internal.

```rust
pub fn load_mesh(bytes: &[u8], file_name: &str) -> Result<Mesh>;               // 3MF, STL, raw parts
pub fn load_3mf_plates(bytes: &[u8], file_name: &str) -> Result<Vec<(u32, Mesh)>>;
pub fn slice(plate: &Plate, config: &PrintConfig, opts: &SliceOptions) -> Result<SliceOutput>;
pub fn slice_range(plate: &Plate, config: &PrintConfig, layers: Range<u32>, halo: u32) -> Result<SliceOutput>;
pub fn emit_gcode(out: &SliceOutput, config: &PrintConfig, flavor: GcodeFlavor, w: &mut impl Write) -> Result<GcodeStats>;
pub fn preview_buffers(out: &SliceOutput) -> Vec<u8>;                            // SXPV
pub fn run_request(req: &SliceRequest, meshes: &dyn Fn(&str) -> Result<Arc<Mesh>>) -> Result<SliceRun>;
pub fn run_request_with(req: &SliceRequest, meshes: &dyn Fn(&str) -> Result<Arc<Mesh>>, progress: &dyn Progress) -> Result<SliceRun>;
pub fn project_metadata(bytes: &[u8], file_name: &str) -> Result<ProjectMetadata>;  // settings entries of a 3MF project
```

Stopping a run: `Progress::cancelled()` is checked per layer and between stages, and the run returns `Error::Cancelled`. `Cancellable { progress, flag }` wraps any `Progress` with an `AtomicBool` to set from another thread.

Request options beyond the flavor and shards: `layerTopsMm` (sleipnir, explicit layer tops), `resumeFromLayer` (G-code only from that layer, after a start that heats and homes X and Y but not Z, with no purge line), `heightRanges` (wall count, temperature, flow, pressure advance, speeds and retraction by height) and per-object `settings` on `plate.objects`. `sx schema request` lists them.

Example, slicing an STL with default settings:

```rust
use sx_core::api::{self, Plate, PrintConfig, SliceOptions};

let mesh = api::load_mesh(&std::fs::read("part.stl")?, "part.stl")?;
let config = PrintConfig::default();
let out = api::slice(&Plate::single(mesh), &config, &SliceOptions::default())?;
let mut gcode = Vec::new();
let stats = api::emit_gcode(&out, &config, config.gcode_flavor, &mut gcode)?;
println!("{} layers, {:.0} s, {:.1} g", out.layer_count, stats.time_s, stats.filament_g.iter().sum::<f64>());
```

`SliceSession` keeps a prepared plate (welded parts, layer plan, triangle buckets) so a host can slice many layer ranges, or re-slice after a settings change, without redoing mesh work. `PrintConfig` holds the settings the core reads, parsed from a JSON object with OrcaSlicer key names: typed values (`15`) and Orca's string forms (`"15%"`, `["0.4"]`) both work, and a line width of 0 means automatic (1.05 times the nozzle).

Units: millimeters in the API. Inside the crate, 2D geometry uses `i32` coordinates at 0.1 micrometer.

## How it slices

1. Layer plan from the first layer height and the layer height.
2. Contours: triangles are bucketed by layer once per session; each layer's cut segments are joined through shared mesh edges into loops, cleaned to 0.0125 mm, and parts on different filaments are made disjoint (the higher slot wins where parts overlap).
3. Walls: fixed-width loops from inward offsets. A fast miter offset with a crossing check handles most loops; loops where it fails go through a union-based offset.
4. Overhangs and bridges: a wall stretch whose bead hangs over the layer below by a quarter of its width or more is written as an overhang wall (slowed by degree with the `overhang_N_4_speed` settings), and infill over air at least 1.5 line widths wide becomes round bridge strands at `bridge_speed` and `bridge_flow`, along the direction that rests on the supported edges.
5. Top and bottom surfaces: every region is sampled on global diagonal scanlines, and a span is solid where any of the next `top_shell_layers` or previous `bottom_shell_layers` layers does not cover it.
6. Infill: the same scanlines at the sparse spacing (rectilinear or grid), trimmed to overlap the inner wall.
7. Path order: per layer, per filament (the order alternates by layer so consecutive layers share a tool at the boundary), islands nearest first with the seam set by `seam_position` (back, nearest, aligned, aligned_back or random; back by default), then infill in serpentine order. The start point depends only on the layer's own geometry, so layer ranges sliced separately join into the same bytes as one run.
8. G-code: absolute XYZ, relative extrusion, formatted per layer in parallel from integers, so output is identical on every platform.
9. SXPV: 32-byte segment records and travels per layer, for the viewport.

## Dependencies

- `i_overlay` 9.0.0 (MIT): polygon union and difference for regions, and the fallback offset.
- `miniz_oxide` 0.9.1 (MIT, Zlib or Apache-2.0): inflate for 3MF archives, pure Rust.
- `rayon` 1.12.0 (MIT or Apache-2.0, optional): per-layer parallelism on native builds.
- `serde` 1.0.229 and `serde_json` 1.0.151 (MIT or Apache-2.0): config, request and model JSON.
- `thiserror` 2.0.21 (MIT or Apache-2.0): the crate error enum.
- `criterion` 0.8.2 (MIT or Apache-2.0, dev only): the benches in `benches/`.

## Status

Works:

- Loading 3MF (core specification, Bambu Studio and OrcaSlicer project files with component files, per-part filament slots, plates and ZIP64), binary and ASCII STL, a quantized JSON model format and raw geometry buffers.
- The full pipeline with walls, top and bottom shells, rectilinear and grid infill, brim, multi-filament plates with tool changes, and G-code for Marlin 2, Klipper and RepRapFirmware (Bambu printers get plain G-code; packaging it as `.gcode.3mf` is up to the host).
- Filament length, grams and cost per slot, and a print time estimate.
- Identical output for any split into layer ranges, and between native and WebAssembly builds (same G-code SHA-256).

Speed on the reference model (`bench/models/x-mark.stl`, 0.20 mm, reference machine Apple M3 Pro with 11 cores): measured numbers are in `bench/README.md` and every hill-climb step is in `bench/LOG.md`.

Not yet: supports, variable-width walls, gap fill, bridges over sparse infill, floating vertical shells, ironing, painted multi-material in 3MF, acceleration in the time estimate, and per-stage caching for re-slicing (a kept `SliceSession` skips mesh preparation only). Contour chains that do not close on an open mesh are dropped and reported as a warning.
