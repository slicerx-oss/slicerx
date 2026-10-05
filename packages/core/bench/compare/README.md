# Slicer comparison harness

Times SlicerX, Bambu Studio and OrcaSlicer on the same models with the same settings, then compares what each one produced. It runs on macOS, Linux and Windows with Python 3.9 or newer and no packages beyond the standard library (Windows peak memory needs `psutil`, optional).

```
python3 compare.py                                   # every slicer it finds, every model, 10 runs
python3 compare.py --models cube,knot --runs 5
python3 compare.py --sx path/to/sx --orca path/to/OrcaSlicer --bambu path/to/BambuStudio
python3 compare.py --selftest                        # checks the generated meshes and exits
```

Results go to `compare-results.json` and `compare-results.md` in the current folder. Files it creates (models, projects, G-code, logs) are kept under `compare-work/`.

Build `sx` first with `cargo build -p sx-cli --profile bench-release` (or `--release`); the harness looks in `target/` and on `PATH`, or take `--sx` or `SX_BIN`. Bambu Studio and OrcaSlicer are found in their default install folders, or take `--bambu`, `--orca` (`BAMBU_BIN`, `ORCA_BIN`). On Linux and Windows installs where the Bambu Studio profile folder is not next to the executable, pass `--bambu-profiles .../profiles/BBL`.

## What is measured

- End to end: process start to G-code on disk, wall clock. Warm-up run first, then the timed runs interleaved (one run of each slicer in turn) so background load lands on all of them.
- Peak memory and CPU seconds of the slicer process (POSIX `wait4`; `psutil` on Windows).
- Phases, when available. Bambu Studio: startup, model load, slicing, G-code writing and exit, from the timestamps in its own debug log. SlicerX: slicing, G-code writer and preview buffer from `sx bench`. OrcaSlicer does not timestamp its log, so it has no phase split.
- Output, read from the G-code in one way for all three: layer count, filament length (sum of positive extrusion on printing moves), the split by feature, arc moves, file size and each slicer's own print time estimate.

Read the output columns before the time column. A slicer that prints less (no bridges, thinner infill, fewer features) finishes sooner, and the report flags filament totals that differ by more than 15 percent.

## Settings

`settings.py` holds one table of values and turns it into each slicer's key names. Highlights: 0.20 mm layers, 2 walls (classic generator), 5 top and 3 bottom layers, 15 percent rectilinear infill, 0.42 mm lines, 5 mm outer brim, no supports, no prime tower, no ironing, no arc fitting, no skirt, no cooling slowdown, 0.4 mm nozzle, 1.75 mm PLA, 256 mm bed, the same speeds and retraction, one filament.

- SlicerX reads the values through `sx slice --config`.
- OrcaSlicer gets three small user presets that inherit its generic Marlin machine, process and PLA filament, plus the overrides.
- Bambu Studio only slices 3MF projects from the command line and ignores a project without a complete settings block. The harness asks Bambu Studio for its own defaults, layers the P1S machine, 0.20 mm process and PLA presets read from the installed app, applies the overrides and writes one 3MF per model. The presets are read at run time and are not stored here. This path is tested on macOS only.

Everything else stays at each slicer's own default. Known differences left in place: seam placement, bridge and overhang handling, gap fill, thin wall detection, travel optimization, the machine start and end G-code, and (for print time) acceleration limits. The estimated print times are each slicer's own model and are not comparable to each other or to a real print.

## Models

Generated from formulas by `models.py`, so there are no mesh files to license (see `MODELS.md`): a 20 mm calibration cube, a 40 tooth spur gear, a twisted vase, a trefoil knot tube, a 1.2 million triangle bumpy torus for large-mesh behavior, and `x-reference`, the X plate from `../models/x-mark.stl` (26,268 triangles). Add a model with `models.register(name, builder)`. Every model is closed, manifold, on z = 0 and centered on the bed.

## Limits

- Bambu Studio and OrcaSlicer have a fixed startup cost that dominates the smallest models (tens of milliseconds before slicing begins). That is part of using them from a script and is reported as measured, with the phase split next to it.
- One printer profile family per slicer (a generic Marlin printer for Orca, a P1S for Bambu). Other profiles change the numbers.
- The harness does not check that G-code prints. It checks that it exists and reads it for the columns above.
