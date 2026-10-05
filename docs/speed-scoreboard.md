# Speed scoreboard

SlicerX against OrcaSlicer 2.4.2, Bambu Studio 01.10 and PrusaSlicer 2.9.6 on the benchmark models (`packages/core/bench/models/suite.py`, the ball and the x-mark). A cell is green when SlicerX is at least 20 percent better than the best of the others on that metric, yellow within 20 percent either way, red when worse.

How it is measured: the reference M3 Pro (5 performance and 6 efficiency cores), each slicer from its command line with the printer's stock presets flattened from the same BBL profiles (Bambu Lab P1S 0.4 and A1 0.4, 0.20 mm Standard, Bambu PLA Basic), G-code written to disk, one warm run and then the median of 5 interleaved rounds. Peak memory is the process's maximum resident size. Supports are on for the knot only, the prime tower for the multi-color rows only. PrusaSlicer has no Bambu Lab profiles, so it runs the same values under its own key names (classic walls, grid infill, no brim) and is missing on the multi-color rows.

Configurations:
- default: what a fresh app sends (aegis walls, sleipnir quality layers planned by `sx-geom layers.plan`, whose time is included).
- aegis and classic: those wall generators at a fixed 0.2 mm.
- The other slicers run their stock presets, which use classic walls on both printers.

## Baseline (e371b71, 2026-10-02)

Wall s / CPU s / peak MB; G, Y, R after each number.

| Model (triangles), printer | default | aegis 0.2 | classic 0.2 | Orca | Bambu Studio | PrusaSlicer |
|---|---|---|---|---|---|---|
| ball, 8 colors (24,082), P1S | 4.08R / 34.2R / 233G | 3.34R / 28.3R / 200G | 2.54Y / 20.0Y / 198G | 3.33 / 20.4 / 839 | 2.74 / 20.2 / 525 | n/a |
| x-mark (26,268), P1S | 0.78R / 5.6R / 74G | 0.54R / 3.9R / 57G | 0.41Y / 2.8Y / 57G | 0.53 / 2.6 / 175 | 0.42 / 2.5 / 108 | 0.45 / 2.4 / 113 |
| x-mark, A1 | 0.77R / 5.8R / 76G | 0.52R / 4.0R / 56G | 0.42Y / 2.9R / 58G | 0.56 / 2.5 / 178 | 0.44 / 2.5 / 110 | 0.38 / 2.3 / 112 |
| tug (154,036), P1S | 0.96R / 6.4R / 116G | 0.63Y / 4.3R / 108G | 0.48G / 3.1Y / 100G | 0.86 / 3.4 / 247 | 0.72 / 3.1 / 149 | 0.74 / 3.8 / 214 |
| tug, A1 | 0.97R / 6.5R / 116G | 0.61Y / 4.3R / 112G | 0.52G / 3.2Y / 101G | 0.86 / 3.4 / 248 | 0.72 / 3.1 / 150 | 0.74 / 3.9 / 216 |
| holes (27,968), P1S | 4.08R / 22.1R / 642R | 3.75R / 20.0R / 582R | 4.65R / 20.9R / 161Y | 1.43 / 5.8 / 374 | 1.10 / 5.2 / 161 | 0.95 / 5.7 / 323 |
| holes, A1 | 4.19R / 22.1R / 658R | 3.91R / 20.2R / 619R | 4.73R / 21.2R / 169Y | 1.43 / 5.8 / 377 | 1.10 / 5.2 / 165 | 0.96 / 5.7 / 322 |
| spire (138,432), P1S | 1.24R / 9.9R / 109G | 1.16R / 9.8R / 109G | 0.59Y / 3.9Y / 103G | 0.97 / 4.2 / 302 | 0.69 / 4.1 / 194 | 0.99 / 5.2 / 241 |
| spire, A1 | 1.25R / 10.0R / 111G | 1.16R / 9.9R / 111G | 0.59Y / 4.0Y / 108G | 0.97 / 4.2 / 308 | 0.71 / 4.0 / 198 | 0.99 / 5.2 / 242 |
| knot with tree supports (138,240), P1S | 14.25R / 72.5R / 483R | 7.08R / 38.3R / 280Y | 6.40R / 31.5R / 287Y | 3.68 / 21.3 / 982 | 2.71 / 13.5 / 336 | 2.63 / 18.5 / 635 |
| knot with tree supports, A1 | 14.50R / 72.8R / 492R | 7.08R / 38.6R / 288Y | 6.39R / 31.7R / 294Y | 3.68 / 21.4 / 978 | 2.74 / 13.5 / 339 | 2.63 / 18.4 / 632 |
| dense (1,200,000), P1S | 5.24R / 30.4R / 473G | 3.26Y / 19.3R / 411G | 2.86Y / 15.5Y / 367G | 4.00 / 14.3 / 933 | 3.49 / 14.0 / 638 | 4.34 / 20.7 / 1032 |
| dense, A1 | 5.39R / 30.3R / 475G | 3.26Y / 19.7R / 414G | 2.88Y / 15.7Y / 372G | 3.96 / 14.1 / 937 | 3.46 / 14.1 / 641 | 4.29 / 20.8 / 1031 |
| plate of 20 parts (332,440), P1S | 5.85R / 44.1R / 293Y | 3.91R / 26.1R / 278Y | 2.99Y / 18.0Y / 247Y | 2.95 / 19.4 / 445 | 2.60 / 18.2 / 278 | 3.65 / 29.4 / 335 |
| plate of 20 parts, A1 | 6.20R / 45.6R / 310Y | 4.07R / 26.7R / 294Y | 3.12R / 18.7Y / 253Y | 3.00 / 19.4 / 444 | 2.53 / 18.4 / 282 | 3.63 / 29.5 / 334 |
| x-mark, 2 colors with tower (36,036), P1S | 0.79R / 4.9R / 68G | 0.64R / 4.1R / 59G | 0.53Y / 3.0Y / 59G | 0.75 / 3.2 / 256 | 0.53 / 2.9 / 129 | n/a |
| x-mark, 2 colors with tower, A1 | 0.79R / 4.9R / 68G | 0.64Y / 4.1R / 59G | 0.54Y / 3.1Y / 59G | 0.79 / 3.2 / 258 | 0.54 / 2.9 / 131 | n/a |

## Now (2026-10-03, 35d1e3e)

One batch of the SlicerX columns on the reference Mac (5 rounds, the first dropped, median of 4), with the cooling settle, lifts, tower, brim per object, overhang fan and M73 changes in. Bambu Studio ran in the same batch and came within 1 to 4 percent of its baseline numbers, so the other slicers' columns stand. The knot is colored against tree supports in all three: wall 2.63 s and CPU 18.5 s (PrusaSlicer), memory 408 MB on the P1S and 404 MB on the A1 (Bambu Studio with tree(auto), whose column below still shows its stock normal(auto) run).

| Model (triangles), printer | default | aegis 0.2 | classic 0.2 | Orca | Bambu Studio | PrusaSlicer |
|---|---|---|---|---|---|---|
| ball, 8 colors (24,082), P1S | 2.15G / 16.6Y / 302G | 1.73G / 13.6G / 256G | 1.36G / 10.3G / 241G | 3.33 / 20.4 / 839 | 2.74 / 20.2 / 525 | n/a |
| x-mark (26,268), P1S | 0.37Y / 2.6Y / 76G | 0.25G / 1.8G / 58G | 0.22G / 1.5G / 56G | 0.53 / 2.6 / 175 | 0.42 / 2.5 / 108 | 0.45 / 2.4 / 113 |
| x-mark, A1 | 0.38Y / 2.6Y / 82G | 0.26G / 1.8G / 59G | 0.23G / 1.6G / 57G | 0.56 / 2.5 / 178 | 0.44 / 2.5 / 110 | 0.38 / 2.3 / 112 |
| tug (154,036), P1S | 0.53G / 2.9Y / 110G | 0.29G / 1.9G / 95G | 0.28G / 1.8G / 81G | 0.86 / 3.4 / 247 | 0.72 / 3.1 / 149 | 0.74 / 3.8 / 214 |
| tug, A1 | 0.53G / 3.0Y / 104G | 0.29G / 2.0G / 96G | 0.28G / 1.8G / 81G | 0.86 / 3.4 / 248 | 0.72 / 3.1 / 150 | 0.74 / 3.9 / 216 |
| holes (27,968), P1S | 0.54G / 3.1G / 112G | 0.45G / 2.7G / 97G | 0.53G / 3.1G / 104G | 1.43 / 5.8 / 374 | 1.10 / 5.2 / 161 | 0.95 / 5.7 / 323 |
| holes, A1 | 0.52G / 3.1G / 113G | 0.46G / 2.7G / 102G | 0.54G / 3.1G / 105G | 1.43 / 5.8 / 377 | 1.10 / 5.2 / 165 | 0.96 / 5.7 / 322 |
| spire (138,432), P1S | 0.48G / 2.6G / 103G | 0.38G / 2.5G / 102G | 0.37G / 2.2G / 108G | 0.97 / 4.2 / 302 | 0.69 / 4.1 / 194 | 0.99 / 5.2 / 241 |
| spire, A1 | 0.51G / 2.7G / 105G | 0.39G / 2.6G / 105G | 0.37G / 2.3G / 113G | 0.97 / 4.2 / 308 | 0.71 / 4.0 / 198 | 0.99 / 5.2 / 242 |
| knot with tree supports (138,240), P1S | 4.00R / 29.5R / 580R | 2.20Y / 16.7Y / 348Y | 2.10G / 15.5Y / 356Y | 3.68 / 21.3 / 982 | 2.71 / 13.5 / 336 | 2.63 / 18.5 / 635 |
| knot with tree supports, A1 | 4.12R / 30.1R / 587R | 2.28Y / 16.7Y / 342Y | 2.20Y / 15.3Y / 340Y | 3.68 / 21.4 / 978 | 2.74 / 13.5 / 339 | 2.63 / 18.4 / 632 |
| dense (1,200,000), P1S | 2.85Y / 14.0Y / 512Y | 1.37G / 8.7G / 449G | 1.45G / 9.0G / 457G | 4.00 / 14.3 / 933 | 3.49 / 14.0 / 638 | 4.34 / 20.7 / 1032 |
| dense, A1 | 2.91Y / 14.2Y / 509G | 1.46G / 8.9G / 448G | 1.46G / 9.3G / 448G | 3.96 / 14.1 / 937 | 3.46 / 14.1 / 641 | 4.29 / 20.8 / 1031 |
| plate of 20 parts (332,440), P1S | 0.99G / 3.5G / 228Y | 0.50G / 2.2G / 163G | 0.50G / 2.0G / 168G | 2.95 / 19.4 / 445 | 2.60 / 18.2 / 278 | 3.65 / 29.4 / 335 |
| plate of 20 parts, A1 | 1.02G / 4.0G / 232Y | 0.54G / 2.5G / 167G | 0.55G / 2.5G / 158G | 3.00 / 19.4 / 444 | 2.53 / 18.4 / 282 | 3.63 / 29.5 / 334 |
| x-mark, 2 colors with tower (36,036), P1S | 0.39G / 2.2G / 76G | 0.29G / 1.8G / 65G | 0.27G / 1.6G / 64G | 0.75 / 3.2 / 256 | 0.53 / 2.9 / 129 | n/a |
| x-mark, 2 colors with tower, A1 | 0.39G / 2.3Y / 78G | 0.30G / 1.9G / 66G | 0.28G / 1.7G / 65G | 0.79 / 3.2 / 258 | 0.54 / 2.9 / 131 | n/a |

Peak memory had risen since 9bab376: about 40 MB from planning supports beside the layers' paths, 16 MB from the cooling settle (the settled layers' G-code was copied again by the writer) and 10 MB from the larger G-code. Three byte-identical changes after this batch take it back down (single runs, P1S): knot classic 353 to about 291 MB, knot default 580 to about 490 MB, ball default 302 to about 250 MB.

- The G-code writer reads the layers the cooling settle wrote where they are instead of copying them.
- The preview writes each layer's segment records straight into the file buffer, which is sized for the extras from the start.
- The organic smoothing keeps each layer's collision lines in one compressed grid instead of a list per cell.

## Earlier (2026-10-02 afternoon, the merged tip with the tree support and holes changes)

SlicerX columns measured again in one batch with the machine otherwise idle; the other slicers' numbers are the baseline's (same machine, same presets).

| Model (triangles), printer | default | aegis 0.2 | classic 0.2 | Orca | Bambu Studio | PrusaSlicer |
|---|---|---|---|---|---|---|
| ball, 8 colors (24,082), P1S | 3.81R / 31.3R / 243G | 3.17Y / 26.2R / 212G | 2.54Y / 19.6Y / 201G | 3.33 / 20.4 / 839 | 2.74 / 20.2 / 525 | n/a |
| x-mark (26,268), P1S | 0.69R / 4.9R / 73G | 0.46Y / 3.3R / 55G | 0.40Y / 2.8Y / 56G | 0.53 / 2.6 / 175 | 0.42 / 2.5 / 108 | 0.45 / 2.4 / 113 |
| x-mark, A1 | 0.70R / 4.9R / 74G | 0.47R / 3.4R / 54G | 0.42Y / 2.8R / 58G | 0.56 / 2.5 / 178 | 0.44 / 2.5 / 110 | 0.38 / 2.3 / 112 |
| tug (154,036), P1S | 0.86R / 5.4R / 120Y | 0.53G / 3.5Y / 111G | 0.49G / 3.1Y / 104G | 0.86 / 3.4 / 247 | 0.72 / 3.1 / 149 | 0.74 / 3.8 / 214 |
| tug, A1 | 0.90R / 5.5R / 119G | 0.55G / 3.5Y / 112G | 0.52G / 3.1Y / 103G | 0.86 / 3.4 / 248 | 0.72 / 3.1 / 150 | 0.74 / 3.9 / 216 |
| holes (27,968), P1S | 2.07R / 8.3R / 167Y | 1.96R / 7.6R / 161Y | 2.47R / 10.4R / 164Y | 1.43 / 5.8 / 374 | 1.10 / 5.2 / 161 | 0.95 / 5.7 / 323 |
| holes, A1 | 2.14R / 8.3R / 174Y | 2.04R / 7.8R / 169Y | 2.53R / 10.6R / 174Y | 1.43 / 5.8 / 377 | 1.10 / 5.2 / 165 | 0.96 / 5.7 / 322 |
| spire (138,432), P1S | 0.85R / 5.8R / 107G | 0.68Y / 4.9R / 105G | 0.57Y / 3.9Y / 103G | 0.97 / 4.2 / 302 | 0.69 / 4.1 / 194 | 0.99 / 5.2 / 241 |
| spire, A1 | 0.87R / 5.9R / 108G | 0.69Y / 5.0R / 108G | 0.59Y / 4.0Y / 108G | 0.97 / 4.2 / 308 | 0.71 / 4.0 / 198 | 0.99 / 5.2 / 242 |
| knot with tree supports (138,240), P1S | 11.56R / 52.9R / 485R | 5.69R / 28.7R / 280Y | 5.75R / 28.5R / 291Y | 3.68 / 21.3 / 982 | 2.71 / 13.5 / 336 | 2.63 / 18.5 / 635 |
| knot with tree supports, A1 | 11.73R / 53.1R / 494R | 5.74R / 28.8R / 290Y | 5.80R / 28.6R / 300Y | 3.68 / 21.4 / 978 | 2.74 / 13.5 / 339 | 2.63 / 18.4 / 632 |
| dense (1,200,000), P1S | 4.43R / 21.2R / 403G | 2.68G / 13.4Y / 369G | 2.78G / 15.1Y / 368G | 4.00 / 14.3 / 933 | 3.49 / 14.0 / 638 | 4.34 / 20.7 / 1032 |
| dense, A1 | 4.41R / 21.3R / 408G | 2.70G / 13.5Y / 374G | 2.78Y / 15.1Y / 371G | 3.96 / 14.1 / 937 | 3.46 / 14.1 / 641 | 4.29 / 20.8 / 1031 |
| plate of 20 parts (332,440), P1S | 5.37R / 39.0R / 305Y | 3.55R / 23.5R / 285Y | 2.73Y / 16.9Y / 254Y | 2.95 / 19.4 / 445 | 2.60 / 18.2 / 278 | 3.65 / 29.4 / 335 |
| plate of 20 parts, A1 | 5.64R / 39.8R / 322Y | 3.63R / 23.8R / 302Y | 2.84Y / 17.1Y / 261Y | 3.00 / 19.4 / 444 | 2.53 / 18.4 / 282 | 3.63 / 29.5 / 334 |
| x-mark, 2 colors with tower (36,036), P1S | 0.71R / 4.3R / 68G | 0.57Y / 3.6R / 57G | 0.52Y / 3.0Y / 58G | 0.75 / 3.2 / 256 | 0.53 / 2.9 / 129 | n/a |
| x-mark, 2 colors with tower, A1 | 0.72R / 4.4R / 68G | 0.57Y / 3.6R / 56G | 0.52Y / 3.0Y / 57G | 0.79 / 3.2 / 258 | 0.54 / 2.9 / 131 | n/a |

## Variable width against variable width (2026-10-02 afternoon)

Orca and Bambu Studio with `wall_generator` arachne in the same flattened presets, all four in one batch per printer, fixed 0.2 mm. SlicerX colors are against the better of the two.

| Model, printer | SlicerX arachne | SlicerX aegis | Orca arachne | Bambu Studio arachne |
|---|---|---|---|---|
| ball, P1S | 3.46Y / 27.2Y / 213G | 3.57Y / 27.3Y / 213G | 3.89 / 25.9 / 853 | 3.56 / 29.2 / 516 |
| x-mark, P1S | 0.52Y / 3.8R / 56G | 0.50Y / 3.9R / 56G | 0.58 / 3.3 / 173 | 0.50 / 3.2 / 107 |
| x-mark, A1 | 0.52Y / 3.9R / 56G | 0.53Y / 3.9R / 56G | 0.62 / 3.2 / 177 | 0.50 / 3.2 / 111 |
| tug, P1S | 0.58G / 3.9Y / 114G | 0.60G / 4.0Y / 113G | 0.91 / 4.0 / 250 | 0.83 / 4.2 / 154 |
| tug, A1 | 0.58G / 3.9Y / 116G | 0.60G / 4.0Y / 116G | 0.94 / 4.0 / 255 | 0.86 / 4.1 / 154 |
| holes, P1S | 2.21R / 9.6R / 316Y | 2.22R / 9.7R / 322Y | 1.35 / 7.1 / 470 | 1.14 / 6.8 / 295 |
| holes, A1 | 2.31R / 9.8R / 324Y | 2.33R / 9.7R / 311Y | 1.33 / 7.1 / 467 | 1.17 / 6.7 / 294 |
| spire, P1S | 0.94Y / 7.9Y / 108G | 0.96Y / 7.9Y / 108G | 1.36 / 8.2 / 302 | 1.01 / 7.3 / 198 |
| spire, A1 | 1.02Y / 7.7Y / 110G | 1.01Y / 8.0Y / 110G | 1.40 / 8.3 / 305 | 1.04 / 7.2 / 202 |
| knot with tree supports, P1S | 6.92R / 37.8R / 279Y | 7.02R / 37.1R / 278Y | 4.04 / 24.3 / 981 | 2.99 / 16.6 / 324 |
| knot with tree supports, A1 | 7.03R / 37.5R / 288Y | 6.97R / 37.8R / 289Y | 3.98 / 24.6 / 969 | 2.96 / 16.8 / 330 |
| dense, P1S | 3.07Y / 18.2Y / 377G | 3.12Y / 18.4Y / 376G | 3.96 / 16.7 / 930 | 3.62 / 16.9 / 626 |
| dense, A1 | 3.13Y / 18.1Y / 378G | 3.16Y / 18.4Y / 378G | 3.95 / 16.8 / 925 | 3.54 / 16.9 / 630 |
| plate of 20 parts, P1S | 3.63R / 24.8R / 286Y | 3.61R / 24.4R / 285Y | 3.09 / 19.8 / 481 | 2.76 / 19.5 / 327 |
| plate of 20 parts, A1 | 3.72R / 25.0R / 305Y | 3.60R / 24.8R / 302Y | 3.09 / 19.8 / 475 | 2.75 / 19.6 / 326 |
| x-mark, 2 colors, P1S | 0.64Y / 3.9Y / 58G | 0.64Y / 4.0Y / 58G | 0.81 / 3.8 / 252 | 0.58 / 3.6 / 127 |
| x-mark, 2 colors, A1 | 0.62Y / 4.0Y / 59G | 0.62Y / 4.0Y / 57G | 0.81 / 3.9 / 255 | 0.57 / 3.6 / 129 |

This batch ran on the tip before the plain-island aegis path and the tree support changes.

## Changes since the baseline

One thread, instructions retired (`/usr/bin/time -l`), G-code unchanged:

| Change | Row | Before | After |
|---|---|---|---|
| Inward offset check skips far contours | holes, classic | 254.3G | 204.8G |
| Slivers cut against the nearby solid area only (native) | holes, classic | 204.8G | 123.8G |
| Tree support differences against the nearby collision area only (native) | knot, classic | 280.3G | 256.0G |
| Tree support intersections against the overlapping parts only (native) | knot, classic | 260.6G | 256.4G |
| Each layer of a tree support branch cut in parallel | knot, classic | wall | see the table |
| Organic support steps that ran on one thread run in parallel (f116a43) | knot, classic | 260.9G | 253.8G |
| Travel containment reads ring edges by band for shapes of any ring count; segment crossings read the bands too | holes, classic | 116.0G | 83.5G |
| Monotonic fill links measure wall segments first and walk the wall for the chosen link only; line end places kept | holes, classic | 83.5G | 71.0G |
| aegis fast path also takes islands whose outline bumps are shallower than half the smallest printable feature (walls within 0.05 mm of the skeleton, filament within 0.06 percent; golden changed) | spire, aegis | 46.6G | 32.5G |
| Same change | x-mark, aegis | 26.7G | 24.4G |
| Same change | ball, aegis | 214.6G | 206.4G |

## Spot checks (2026-10-02 evening, no full batch)

Knot with tree supports, classic, P1S, 11 threads, machine otherwise idle, median of 3 to 5 rounds: 5.60 s / 28.9 CPU s / 173 MB on 6f7be23, 3.73 s / 29.6 CPU s / 173 MB with f116a43. Bambu Studio is 2.71 / 13.5 / 336 and PrusaSlicer 2.63 s, so the row is still red on wall and CPU.

Plate of 20 parts on 6f7be23 (copies sliced once), filament mm and estimated time s against Orca: P1S classic 11,702 and 7,311 (Orca 11,737 and 7,200: -0.3 and +1.5 percent); A1 classic 11,705 and 8,118 (Orca 11,740 and 8,212: -0.3 and -1.1 percent).

Engine WASM (zlib level 9 of `sx_wasm.wasm`, wasm-release): 1025.0 KB on 6f7be23, 1027.7 KB with the three changes above; the budget is 1100 KB.
