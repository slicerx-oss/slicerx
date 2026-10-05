# Native slice hill-climb

Iterations 1 to 22 ran on an earlier reference plate that is not part of the repository (24,100 triangles, five filament parts, 508 layers at 0.20 mm). From iteration 23 the reference is `models/x-mark.stl` (427 layers), and the extrusion baseline was reset for it.

Reference plate at 0.20 mm on the reference machine, `--profile bench-release`. Baseline and candidate are medians of interleaved A/B runs (15 rounds, each the median of 3 runs after 2 warmups). Full median, p90 and gates come from `sx bench --runs 15 --warmup 3` on the candidate. Times in ms.

| # | Time (UTC) | Change | Baseline | Candidate | Gain % | Full median | p90 | 1 thread | RSS MB | Layers | G-code valid | Extrusion delta % | Shards equal | Kept |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2026-09-30T07:23:34Z | drop contour points within 0.0125 mm of the line through their neighbors before building regions | 71.13 | 71.14 | -0.01 | 70.77 | 71.46 | 466.78 | 159 | 508 | yes | 0.001 | yes | no |
| 2 | 2026-09-30T07:24:43Z | bevel joins instead of 30 degree clipped miters in wall offsets | 70.86 | 175.96 | -148.32 | 176.31 | 186.27 | 1203.48 | 146 | 508 | yes | -0.162 | yes | no |
| 3 | 2026-09-30T07:32:21Z | own miter offset for walls with an edge-crossing check, Clipper-style positive-union fallback instead of i_overlay outline | 70.13 | 34.61 | 50.65 | 34.22 | 34.92 | 205.14 | 164 | 508 | yes | 0.119 | yes | yes |
| 4 | 2026-09-30T07:33:40Z | build region shapes directly from cut loops when no edges touch; i_overlay simplify only as fallback | 34.32 | 33.4 | 2.68 | 33.2 | 33.86 | 196.61 | 160 | 508 | yes | 0.121 | yes | yes |
| 5 | 2026-09-30T07:35:13Z | skip the slot-priority difference when two regions have no touching edges and no vertex inside each other | 33.95 | 33.92 | 0.09 | 33.49 | 33.96 | 197.05 | 173 | 508 | yes | 0.12 | yes | no |
| 6 | 2026-09-30T07:45:03Z | format SXPV segment records per layer in parallel | 33.39 | 32.52 | 2.61 | 32.21 | 32.8 | 191.39 | 170 | 508 | yes | 0.121 | yes | yes |
| 7 | 2026-09-30T07:46:27Z | weld parts in parallel and move welded parts into the layer buckets instead of cloning | 33.02 | 33.33 | -0.94 | 33.04 | 34 | 202 | 166 | 508 | yes | 0.121 | yes | no |
| 8 | 2026-09-30T07:47:28Z | re-measure of iteration 7's candidate: the intended edit did not apply and cargo kept the stale build of 7 after the revert (restored files had old mtimes) | 35.68 | 35.58 | 0.28 | 32.73 | 33.65 | 194.74 | 163 | 508 | yes | 0.121 | yes | no |
| 9 | 2026-09-30T07:48:15Z | bounding-box reject before the exact crossing test in swallowtail removal | 35.35 | 33.45 | 5.37 | 30.93 | 31.36 | 184.23 | 172 | 508 | yes | 0.121 | yes | yes |
| 10 | 2026-09-30T07:49:33Z | check 12 instead of 32 following edges for swallowtails | 31.28 | 29.33 | 6.23 | 29.05 | 29.94 | 166.81 | 166 | 508 | yes | 0.13 | yes | yes |
| 11 | 2026-09-30T07:51:52Z | check 6 instead of 12 following edges for swallowtails | 30.28 | 29.33 | 3.14 | 28.67 | 29.27 | 171.71 | 172 | 508 | yes | 0.133 | yes | yes |
| 12 | 2026-09-30T07:52:35Z | check 3 instead of 6 following edges for swallowtails | 29.3 | 29.93 | -2.15 | 29.02 | 29.78 | 186.37 | 182 | 508 | yes | 0.136 | yes | no |
| 13 | 2026-09-30T07:53:53Z | count open edges with one sort of undirected keys instead of a binary search per edge | 34.54 | 37.35 | -8.14 | 30.17 | 32.42 | 183.11 | 175 | 508 | yes | 0.133 | yes | no |
| 14 | 2026-09-30T08:01:08Z | count open edges with one sort of undirected keys (retry of 13 under lower background load) | 32.04 | 30.07 | 6.15 | 30.41 | 34.72 | 223.4 | 179 | 508 | yes | 0.133 | yes | yes |
| 15 | 2026-09-30T08:03:09Z | offset each wall and the infill boundary from the previous wall instead of from the region outline | 30.37 | 29.63 | 2.44 | 38.58 | 77.47 | 185.04 | 182 | 508 | no | 5.36 | yes | no |
| 16 | 2026-09-30T08:05:06Z | fix: cap shrinking miters at 3x the offset and grow the complement for sharper corners, so a hairpin cannot throw a point outside the part | 29.94 | 30.43 | -1.64 | 29.84 | 31.77 | 184.23 | 167 | 508 | yes | 0.122 | yes | yes |
| 17 | 2026-09-30T08:05:54Z | offset each wall and the infill boundary from the previous wall (retry of 15 with the miter cap) | 30.46 | 51.43 | -68.84 | 56.47 | 78.4 | 329.91 | 175 | 508 | yes | 0.024 | yes | no |
| 18 | 2026-09-30T08:25:55Z | also cut near crossings whose loop is under 0.01 mm2, whatever its winding | 28.37 | 26.22 | 7.58 | 25.55 | 26.62 | 182.95 | 180 | 508 | yes | 0.095 | yes | yes |
| 19 | 2026-09-30T08:27:06Z | format G-code numbers into one stack buffer per value instead of digit loops and two appends | 26.77 | 26.94 | -0.64 | 25.69 | 26.7 | 163.22 | 170 | 508 | yes | 0.095 | yes | no |
| 20 | 2026-09-30T08:32:39Z | fix: simplify cut contours to 0.0125 mm and grow brim loops one from the next at 0.05 mm resolution (an 80 MB Bambu project went from 38 s to 0.44 s) | 26.02 | 18.24 | 29.9 | 18.21 | 18.55 | 103.5 | 174 | 508 | yes | 0.011 | yes | yes |
| 21 | 2026-09-30T08:35:17Z | i64 instead of i128 math in scanline crossings, contour simplification and point-in-polygon | 18.63 | 17.64 | 5.31 | 17.09 | 17.35 | 109.14 | 160 | 508 | yes | 0.011 | yes | yes |
| 22 | 2026-09-30T08:43:19Z | format each layer's G-code and SXPV records in the same parallel task that plans it (slice_range_prebuilt) | 17.55 | 17.49 | 0.34 | 18.78 | 38.13 | 102.41 | 221 | 508 | yes | 0.011 | yes | no |
| 23 | 2026-09-30T09:13:29Z | fix: scale plate preparation on large meshes: weld by one parallel sort, move parts instead of copying, count open edges only on request (a 3.6M triangle mesh went from 384 to 80 ms) | 5.32 | 4.26 | 19.92 | 5.07 | 7.51 | 20.24 | 52 | 427 | yes | 0 | yes | yes |
