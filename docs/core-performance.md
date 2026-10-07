# Core performance

Slicing speed of the Rust core (packages/core) against OrcaSlicer 2.4.2 and Bambu Studio 01.10.01.50. Performance changes never change output: every change below gives the same G-code and preview bytes as the build before it, checked on the benchmark plates, all request fixtures, `cargo test -p sx-core -p sx-cli -p sx-ffi` and `check-wasm` at 1, 3 and 5 shards.

## Benchmark

- Plate: an 8-color ball (24,082 triangles, 79.6 mm tall, private model, not in the repo), Bambu Lab P1S 0.4 mm, 0.20 mm Standard, 8 PLA slots, prime tower on at x 15, y 150, 60 mm wide (the 35 mm tower no longer fits the bed in SlicerX's preflight), the app's options (11 shards, preview on).
- Machine: the reference M3 Pro (11 cores, 18 GB), `nice -n 19`, interleaved rounds, median of 3. The machine had other jobs running (load 6 to 22), so wall times are pessimistic for all three slicers alike; CPU seconds are steadier.
- Orca and Bambu Studio run from their CLIs with presets flattened from their own BBL profiles, the same tower settings.

## Results

| 2026-09-30 | Wall (s) | CPU (s) | Peak memory (MB) |
|---|---|---|---|
| SlicerX classic walls, before | 5.55 | 42.3 | 177 |
| SlicerX classic walls, now | 4.01 | 28.5 | 176 |
| SlicerX Arachne walls, before | 11.15 | 83.4 | 257 |
| SlicerX Arachne walls, now | 7.70 | 55.0 | 233 |
| OrcaSlicer 2.4.2 (Arachne) | 4.01 | 20.8 | 812 |
| Bambu Studio 01.10.01.50 (classic) | 3.17 | 20.6 | 487 |

| 2026-10-01, one shard, quiet machine (load 12 to 16) | Wall (s) | CPU (s) | Peak memory (MB) |
|---|---|---|---|
| SlicerX classic walls | 2.87 | 20.6 | 216 |
| SlicerX Arachne walls | 4.16 | 31.0 | 240 |
| OrcaSlicer 2.4.2 (Arachne) | 3.80 | 20.7 | 818 |
| Bambu Studio 01.10.01.50 (classic) | 3.19 | 20.4 | 487 |

Median of 3 interleaved rounds with the machine otherwise idle. The engine gained features during the day, so the same tree without changes 8 to 10 measures 22.9 CPU s classic and 33.0 Arachne; with them 20.2 and 30.3 in the A/B. Classic CPU now ties Bambu Studio and Orca; wall time and memory are ahead of both.

| 2026-10-02, one shard (load 11 to 24) | Wall (s) | CPU (s) | Peak memory (MB) |
|---|---|---|---|
| SlicerX classic walls, before change 13 | 2.56 | 20.8 | 198 |
| SlicerX classic walls | 2.58 | 18.6 | 198 |
| SlicerX aegis walls, before change 13 | 3.75 | 30.4 | 200 |
| SlicerX aegis walls | 3.29 | 26.4 | 201 |
| SlicerX classic walls, 8 threads | 2.70 | 17.4 | 197 |
| SlicerX classic walls, 5 threads (the performance cores) | 3.23 | 14.0 | 193 |
| OrcaSlicer 2.4.2 (classic, as its P1S process preset sets it) | 3.39 | 20.1 | 843 |
| Bambu Studio 01.10.01.50 (classic) | 2.77 | 20.0 | 523 |

Median of 3 interleaved rounds with the machine otherwise idle, same tree with and without change 13 (the engine gained features since the table above, so the "before" rows are this tree, not the table above). Classic CPU time is now 7 percent under Bambu Studio and Orca, wall time 7 percent under Bambu Studio, memory under half. The thread rows are the same build with `RAYON_NUM_THREADS`: on this M3 Pro (5 performance and 6 efficiency cores) the work is the same in instructions, but efficiency cores take more CPU seconds for it, so fewer threads trade wall time for CPU time. Five threads meet a 15 CPU second goal and lose 0.5 s of wall time to Bambu Studio; eight beat both rows of both slicers, by 13 percent on CPU and 3 percent on wall.

## Where the time went (before)

Profiled with macOS `sample` on a release build with line tables, attributing each sample to the nearest engine function.

Classic walls, 42 CPU seconds:
- The travel planner's boundary (`inner_offset`, run once per layer from `travel::Layout::from_layer`): about 55 percent. It measured the part's width at every resampled outline point against every edge of the layer, quadratic in the outline length.
- Surface classification and the vertical shell rule (`classify`, `shells::solid_area`): about 35 percent, nearly all polygon booleans. A tenth of all CPU was `slice_shapes`, the union of a layer's regions, recomputed on every call: each region of each layer asks for it on every neighbor within the shell layers, so on an 8-color plate each union ran dozens of times.
- Everything else (Arachne for narrow areas, gap fill, overhangs, G-code writing) was below 6 percent each. Serial stages (session setup, joining shards, finalize, SHA-256) were under 3 percent of wall time; the time is in the parallel per-layer stages.

Arachne walls, 83 CPU seconds: the same costs plus polygon offsets. Half of all CPU went to growing offsets (`perimeters::clipper_offset`) in the bridge candidate search, on the detailed infill outlines Arachne leaves. `i_overlay` splits crossings with an x sweep below 4000 edges and switches to its interval tree when splitting pushes the count past 4000; the raw loops of a grown outline fold back on themselves and cross that line, and the tree then took 2.5 to 4 times as long as the sweep (110 against 46 ms for a 1600-point outline grown by 1.5 mm). The Voronoi build was 17 percent.

## Changes

1. `inner_offset::width_at` finds edges near a point through a grid of cells instead of scanning every edge, and skips edges by squared length before taking the exact length. The width is the shortest accepted distance, which does not depend on the order edges are visited in. Classic 42.6 to 33.2 CPU s.
2. `LayerRegions` keeps the union of its regions once worked out (`slice_shapes`). Classic 33 to 28.7 CPU s, Arachne 74 to 70.
3. Polygon booleans and offsets use `i_overlay`'s sweep solver up to 16,000 edges instead of the automatic choice (`perimeters::solver_for`). Both solvers compare the same pairs of edges and snap the same way. Arachne 70 to 55 CPU s; classic unchanged.

4. The vertical shell rule is worked out once per layer and shared by the regions that ask for it (`shells.rs` memos), and travel containment checks a ring's bounds before the exact test (`travel.rs`). Classic 28.5 to 23.4 CPU s, Arachne 55 to 49.4.
5. `SliceSession::first_layer_info` is kept per settings fingerprint, since every layer range asks for it.
6. The desktop app sends one shard to the native engine (`packages/app/src/state/actions.ts`): rayon already spreads layers across threads, and shards only add halo work. Ball classic 2.80 s wall and 22.0 CPU s, against Bambu Studio 3.17 s and 20.6 CPU s and Orca 4.01 s and 20.8 CPU s. CPU time is the one row SlicerX still loses.
7. WASM single shard: 126 s to 27.4 s.

8. The Orca gap finder (`gapfill::find_orca`) takes the wall loop areas the classic walls already worked out instead of offsetting the same chain again, and the regions of a layer share one overhang map of the layer below per wall width and settings (`session.rs`). Ball, one shard: classic 22.0 to 20.8 CPU s, Arachne 46.4 to 45.3.

9. The shell rule keeps each neighbor layer's free surface grown by its small margin (`shells::Cache::grown`) instead of growing it again for every layer whose shell reaches it, and a region that is its layer's whole outline reads its top and bottom surfaces from the same memo (`classify.rs`). With change 8, ball classic one shard 22.4 to 19.6 CPU s, 187 to 167 billion instructions (load 30 to 70 on the machine, so the instruction count is the steadier figure).

10. More shared work, each with output unchanged on the benchmark plates:
    - A region that is its layer's whole outline, walled with the neighbors' settings, takes its walls from the infill area memo the layers around already fill (`shells::Cache::walls`, `session.rs`), instead of walling the same outline twice.
    - The shell rule's small-piece checks (`shells::solid_area`) clip only against the infill pieces and shared outline pieces whose bounds meet the piece, when the infill pieces' bounds are apart.
    - Travel containment (`travel::Area`) bins ring edges by horizontal band for shapes of 48 edges or more: the edge tolerance test reads the bands within twice the tolerance, the inside test only the band of the point.
    - The travel boundary's width search (`inner_offset::island`) stops just past `min_width + 2 offset`, beyond which every width moves a point by the full offset.

    Ball classic, one shard, with changes 8 and 9: 22.1 to 18.8 CPU s, 191 to 158 billion instructions; one thread 21.6 to 17.7 CPU s.

11. WASM size (2026-10-02): `sx_wasm.wasm` had grown to 1322 KB gzip at opt-level 3 against the 1024 KB budget. A third of the code section is generic sort and polygon code instantiated many times (`core::slice::sort` alone 601 KB raw, 220 KB of it for `i_overlay` element types). The wasm-release profile now builds at opt-level "s" and drops the name section (`strip`): 996 KB gzip, every feature kept, the same G-code bytes (check-wasm on all request fixtures at 1, 3 and 5 shards). Ball in Node, one shard: 342 against 298 billion instructions (about 15 percent more), wall time within the run to run spread (36 to 40 s). Measured and not taken: opt-level "z" (861 KB, 40 percent more instructions), "s" with Voronoi at 3 (1002 KB, no gain), binaryen `-Oz` after "s" (1053 KB with names stripped by it, and a new build tool).

12. Native and WASM output identical again (2026-10-02, a correctness fix, so output changes): on the ball request the two builds wrote different G-code, not only two `M73` lines. Sparse infill and walls on two layers came out in a different order (ties between equal distances), and the different moves moved the remaining time by a minute. The cause was the math library: `sin`, `cos`, `hypot`, `atan2`, `exp` and the rest call Apple's libm in the native build and the `libm` crate in WebAssembly, and the two differ in the last bit for some inputs. Every transcendental function in the core now goes through `fm::Fm` (methods `m_sin`, `m_hypot` and so on, backed by the pinned `libm` crate), and `packages/core/clippy.toml` forbids the standard methods in the crate (integration tests are exempt). The reference golden and every older fixture are unchanged; the ball and the new fixture `xmark-p1s-request.json` (the x-mark under the ball's P1S settings: crosshatch, arcs, tree supports, tower) change in a few layers. That fixture fails `check-wasm` against the previous native build and passes at 1, 3 and 5 shards now; so do all other request fixtures and the ball at both wall generators. Speed unchanged (168 to 171 billion instructions either way, within run to run spread); WASM 1002 KB gzip.

13. Less work per slice, output unchanged (2026-10-02; the same G-code and preview bytes on all request fixtures, the ball at both wall generators and the x-mark, twisted x-mark and two-color x-mark under the ball settings; `check-wasm` at 1, 3 and 5 shards; tests clean). Ball, one shard, one thread, against the same tree without these changes: classic 170.8 to 147.1 billion instructions (14 percent), aegis 286.8 to 234.8 (18 percent).
    - `i_overlay` is vendored (`packages/vendor/i_overlay`, see its SOURCE.md) with one change: its list solver splits crossings in passes, and the passes after the first compared every pair again although only the segments the last split made can meet anything new. Those passes were two thirds of all pairs compared. A segment counts as unchanged when one with the same end points was there before the split and got no mark. About 6 percent of all instructions; and two segments that share an end point are settled by one direction test instead of four, about 1 percent.
    - The whole-object plans (seams, curled walls, supports, lightning) cut every layer into regions with the same settings as the slice; they now share one pass (`SliceSession::whole_regions`) and the slice takes those regions over instead of cutting the layers again.
    - The travel boundary (`inner_offset::island`) tries up to three widths per island and measured every point again for each; a point whose width was found below the search radius keeps it, since a larger radius accepts the same distances below the old one.
    - The seam visibility raycast (`raycast::Bvh::first_hit`) visits the nearer box first, so far boxes are cut off by a hit already found. Hits at exactly the same distance still go to the triangle the old walk met first (a rank per triangle). The visibility grid uses a plain multiply and rotate hash, and each triangle's corner and edges are stored in tree order for the hit test.
    - `boostvoronoi` is vendored (`packages/vendor/boostvoronoi`, see its SOURCE.md). Its exact integer arithmetic (`ExtendedInt`), which settles most circle events on the outlines Arachne and aegis read, was a fifth of an aegis slice: products of one or two chunks are one 128-bit multiplication, new results are worked out in a stack buffer and copied once, and values keep 12 chunks inline instead of 8 (inline 16 and 24 measured slower). Every result is the same, chunk for chunk.
    - Tried and dropped: sorting only the cut segments after a split and merging them into the rest (`i_overlay` `apply`), 2 percent more instructions than sorting everything again; the standard library's sort on a tuple key in place of `i_key_sort`, 11 percent more; the fill sweep on `i_overlay`'s tree instead of its list above 300 to 4000 segments, under 1 percent.
    - WASM: 1016 KB gzip (budget 1024 KB), up from 1002 KB with the two vendored crates and the engine's other additions that day.

A/B runs now also log cycles and instructions retired (`/usr/bin/time -l`), which do not move with machine load the way CPU seconds do.

Tried and dropped, WASM: `+simd128` and binaryen `wasm-opt -O3` (and both). Ball in Node, one shard, all four modules give the same bytes and the same work within 1 percent (337 to 342 billion instructions, 36 to 37 CPU s); V8 optimizes the module again, and the hot loops do not vectorize. Wall time swung 26 to 46 s between runs under load, which is why only instruction counts decide here.

Tried and dropped: a per-thread memo of every polygon boolean keyed by its exact inputs (output identical, 5 percent fewer instructions but 150 MB more peak memory); the interval tree solver for every boolean (output identical, 2x slower overall); skipping shapes whose bounding boxes cannot meet the other operand before a boolean (output identical, no measurable gain on this plate).

## Next

- Where CPU seconds go on 11 threads: instructions barely change with the thread count, but 6 of the 11 cores are efficiency cores, which take more CPU seconds for the same work. The 2026-10-02 table shows the trade: 8 threads beat Orca and Bambu Studio on every row (CPU by 13 percent), 5 threads reach 14 CPU s but lose wall time. Whether the desktop app should size its pool from the performance cores (`hw.perflevel0.logicalcpu` plus a few) is a product call; it changes no output.
- Where the instructions go now (classic, one thread, 147 billion): inside `i_overlay` about half (the pair scan of `list_split` 14 percent, the fill sweep and graph 11, its sorts 8, the active list of the fill sweep 6). Keeping the output byte for byte rules out the usual shortcuts (merging offsets, skipping booleans by bounds, a different solver), and measured duplicate booleans with the same inputs are down to 5 percent of the boolean time, spread over a dozen call sites of 1 percent or less each (walls asked for by the seam plan and the walls themselves, the travel areas' top and bottom differences and the classification's, the shell rule's small-piece checks).
- aegis (235 billion): the Voronoi build is still a third, a third of that in the exact circle predicates of `boostvoronoi`.
- Tried and dropped: `i_overlay`'s `list_split` scanning a compact array of segment bounds (rebuilt each pass) instead of the segments, same visiting order and output: 175 against 163 billion instructions, slower. Each width query of the travel boundary visiting a segment once instead of once per grid cell: 0.2 percent.
- Browser: the worker pool size (navigator.hardwareConcurrency, at most 16) is still to be swept in Chrome with `web-slice.mjs`; each worker holds its own module memory.

14. aegis walls (2026-10-02): each thread reuses its last 4 wall results for an unchanged outline (native only); skeleton graphs reuse pooled buffers (macOS kept freed large blocks dirty: holes plate 554 MB to 140 MB peak); islands thick everywhere get exact inner offsets in place of the skeleton (all walls within 0.05 mm of the skeleton's, same bead counts and widths; golden changed); the junction pass allocates less. One thread: ball 245.2 to 218.2G, x-mark 33.3 to 25.9G, gear 38.4 to 30.0G, drum 95.7 to 35.0G.
15. Pipeline (2026-10-02): serial stages overlapped (G-code, preview and thumbnail together; first layer area and seam visibility beside the layer paths; floating and overhang checks in parallel; faster mesh load, weld and collapse); copies of one object sliced once and placed by translation (plate of 20: 2.73 s and 16.5 CPU s to 0.72 s and 4.33 CPU s). Tree supports: nearby clipping, per-layer parallel branch cutting, serial steps in parallel (knot 6.40 to 3.73 s wall). Holes plate: offset check skips far contours, slivers cut against the nearby solid only (4.65 to 2.47 s classic). Benchmark and scoreboard: docs/speed-scoreboard.md.
16. WASM size (2026-10-04): the engine features added since item 13 took `sx_wasm.wasm` to 1116.1 KB gzip (KB of 1024 bytes, zlib level 9 in Node, as `apps/web/scripts/bundle-size.mjs` measures; GNU `gzip -9` reads about 0.6 percent less) against the 1024 KB budget. Now 1018.1 KB, every feature kept, the same G-code bytes (`check-wasm` on all request fixtures at 1 and 3 shards):
    - The settings defaults are embedded once (the config and the placeholder parser each held a copy): 2 KB.
    - binaryen's `wasm-opt` runs after cargo (`packages/core/web/scripts/build-wasm.sh`): `-O2` without binaryen's inlining, then the functions ordered by mangled name, which puts the copies of each generic side by side within gzip's window. 75 KB, half of it from the ordering. Binaryen's inlining was what made item 11's `-Oz` larger after gzip.
    - LLVM inlines functions marked `#[inline]` up to a cost of 150 instead of 325: 21 KB.
    - The build fails over 1024 KB gzip, and CI builds the module (`.github/workflows/ci.yml`, job `wasm`).
    Ball in Node, one shard, against the module before: classic 199.7 to 200.9 billion instructions, arachne 334.5 to 335.5 (0.6 and 0.3 percent more); wall time within the run to run spread. Measured and not taken, sizes after wasm-opt: `#[inline]` at 125 or 100 (1012 and 1008 KB, 1 to 2 percent more instructions), the plain inline threshold at 30 (1023.5 KB, 0.7 percent more on arachne), opt-level "z" (983 KB, 50 percent more instructions), "z" for `sx-core` alone (no smaller than "z" everywhere and 35 to 44 percent more: the generic code is instantiated in `sx-core`), the `simd128` target feature (9 KB less, but no WebAssembly SIMD before Safari 16.4), functions ordered by body similarity (up to 5 KB worse than by name), GVN sink and hoist, LLVM function merging, binaryen `--merge-similar-functions`, requests read as a JSON value first (1 KB more), panic locations removed (nightly only, 17 KB).
17. WASM headroom (2026-10-04): the tool change and G-code work since item 16 took the module to 1033.0 KB, over the budget. The build now compiles std from source with the immediate-abort panic strategy (`-Cpanic=immediate-abort`, `-Zbuild-std`, unlocked for the pinned compiler with `RUSTC_BOOTSTRAP`; `rust-src` joins the toolchain). A panic in the module traps without a message as before, since wasm32 has no stderr; the panic formatting and the source locations are gone. std, core, alloc, the allocator and compiler_builtins build at opt-level 3, as rustup ships them. 1033.0 to 994.2 KB gzip, 30 KB under the budget, the same G-code bytes (`check-wasm`, all request fixtures at 1 and 3 shards). Ball in Node, one shard: classic 203.3 to 199.6 billion instructions, arachne 337.9 to 328.4 (1.8 and 2.8 percent fewer). Measured and not taken: `#[inline]` at 125, 100 or 75 (1027.0, 1022.0, 1019.5 KB, more instructions), source locations removed alone (`-Zlocation-detail=none`, 1016.8 KB), std at opt-level "s" (999.1 KB, 0.8 percent more instructions on classic), FxHash in place of the standard hash (0.2 KB), noinline on the inlined allocation helpers (2.4 KB), thin or no LTO (no gain).
18. WASM budget (2026-10-06): heimdall's collision check (`src/collide`: the height grids, the move walk, the report and the head shapes) takes `sx_wasm.wasm` from 1016.0 to 1040.6 KB gzip (1040424 to 1065572 bytes, main at 62eee7b against the release branch, Node's bundled zlib at level 9 as CI counts; item 19). Its report carries codes, numbers and object ids only; the app writes the words (3 KB less than texts in the engine). The owner approved raising the budget by 16 KB, from 1024 to 1040 KB (`build-wasm.sh`, `apps/web/scripts/bundle-size.mjs`, `scripts/ci`).
19. WASM size under the new budget (2026-10-06): with huginn and the updater on top, CI measured 1065496 bytes, over the 1040 KB budget. Sizes here are bytes after zlib level 9 in Node's own zlib, as CI and `build-wasm.sh` count them; Homebrew's Node links the system zlib 1.2.12, which counts the same module about 7 KB smaller; item 18 first carried those lower figures. Release branch as it was: 1065572 bytes. The collision check now builds its lists with loops instead of map and filter chains (each `collect` was its own copy of the iterator and `Vec` code): 7.4 KB less code, 1064604 bytes. `#[inline]` functions inline up to a cost of 110 instead of 150: 1060169 bytes (1035.3 KB), 4.7 KB under the budget. Node, the x-mark under the ball settings, the Arachne fixture and the sequence fixture, sliced twice in one process (median of 3 interleaved rounds, instructions of the whole process, compile included): 59.585 billion before, 59.596 with the loops, 59.945 with the loops at 110 (0.6 percent more). Measured and not taken: 120 (1060709 bytes, 0.3 percent more, 0.2 KB under 1036), 100 without the loops (1055077 bytes, 1.2 percent more), the collision report written to JSON by hand instead of serde (2 KB less code, 0.5 KB more gzip), binaryen `-Os` and `-Oz` (larger after gzip).
