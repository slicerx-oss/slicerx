# G-code output fingerprints

Run with the Python standard library in isolated mode:

```sh
python3 -I scripts/bench/gcode-fingerprint.py plate.gcode -o fingerprint.json
python3 -I scripts/bench/test-gcode-fingerprint.py
```

The script maps observed SlicerX, Bambu Studio, and OrcaSlicer feature comments to common names. It records per-feature depositing layers, nominal heights, positive spatial extrusion, path length, and move counts. It also records non-depositing spatial travel including wipe moves, grouped negative-E retractions, completed within-layer Z-hops, outer-wall start candidates, and emitted time and filament estimates. All units are millimeters, seconds, or grams as indicated by JSON field names. Peak memory and slice wall time must be measured externally.

Outer-wall starts and their per-layer bounding-box diagonal are seam proxies. Separate islands and fragmented paths contribute to them. Zero labeled extrusion does not independently prove absence of a physical feature. E-only recovery and purge are excluded from feature deposition. Homing and firmware-internal movement are not estimated. XY-plane arcs with incremental I/J centers or R radii are supported; check input commands for unsupported G18, G19, or G90.1 before comparing results. Layer heights come from the first height comment after each layer marker.

Use three exclusive runs per slicer/model for timing and peak-memory medians, and retain the selected output and full command/profile provenance outside the repository. Compare identical project profiles where supported and explicitly qualify fallback printers. Failed slices are completion gaps, not performance scores. Preserve earlier runs when refreshing a matrix. Read only competitor output and public CLI behavior; do not consult competitor source.

No benchmark models or machine-specific profiles are included. The regression tests create small G-code strings and check known distances and state transitions.
