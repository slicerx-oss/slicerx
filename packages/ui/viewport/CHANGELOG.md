# Changelog

All notable changes to `@slicerx/viewport` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- IDEX tool changes (`idex-park`): the printing carriage parks at its own end of X while the other one comes in for the next move, at once on the Snapmaker J1, one after the other elsewhere. `toolChangerSpec` takes the catalog's kinematics as a fifth argument (`ChangerHints`) and reads `idex` before it counts nozzles. A pose carries both carriages' X (`carriages`, `active`), and the toolhead draws two of the family's heads on one rail.
- Klipper tool changers (`klipper-dock`): with `ChangerHints.toolchanger` (the printer is declared a tool changer, with the docks its config gave) a Klipper printer with two or more nozzles docks its tools on the front top frame along the StealthChanger dock path. `ToolChangerSpec.klipper` holds each dock's park point and whether it was measured; values the printer did not give are estimated. The toolhead draws the generic head on a shuttle and the docks with the parked tools.
- The Prusa Core One with INDX (`front-dock`): passive nozzle tools in docks along the front. The head backs its tool into its dock and releases it, runs along the row to the next dock, latches that tool and pulls it out, heats it, blobs at the purge collector and wipes, and returns; the heat takes what the profile's change time leaves after the moves. `ToolChangerSpec.frontDock` holds the dock X of each tool, the seat and clearance Y and the purge collector. The toolhead draws the Smart Head over a passive tool, the docks with the parked tools (spares in steel) and the purge collector.
- `ViewportPart.normals`: exact corner normals from the geometry engine, packed as `MeshPart.normals` in @slicerx/contracts (six int16 per triangle). A triangle with all three corners set shades with them; the rest keep the 40 degree crease rule, so a part without them draws exactly as before. The mesh worker gets the packed buffer and unpacks it, and a big part with every triangle set shows its final shading at once, with no smooth stand-in.
- `ViewportPart.faceIds`: optional and additive, each triangle's face of the solid (`MeshFaces.ids` in @slicerx/contracts). A part from the geometry engine, with a face id for every triangle and its exact normals, draws an edge line only between two different faces, and only where the shading breaks: where the normals the part is shaded with (the 40 degree crease rule, `CREASE_DEG`) differ by more than 1 degree (`SHADE_BREAK_DEG`) at either end of it. So no line shows inside a flat or curved face, along a fillet's tangent edge, or along the join between two pieces of a smooth loft that shades as one surface. Open borders draw as before. The mesh worker's edges job (`MeshBuildRequest`) carries the normals and face ids, so a big part gets the same lines. A part without a face id for every triangle, or without the engine's normals, draws exactly as before.
- `ChangerHints.copy`: a print in an IDEX copy mode (duplication or mirror, read by the caller from the start G-code) has no changer, since both carriages print the whole time.

### Changed

- The Snapmaker J1 no longer plays the H2D's purge chute switch, and the Snapmaker Artisan plays no tool change until its mechanism is checked.

## [0.2.8] - 2026-11-08

### Added

- Paint up to filament 32. `MAX_PAINT_STATE` is 32, and `decodeTree` and `encodeTree` take a `PaintScheme`: `run` (the default, the `paint_*` attributes, where 19 is `1FC` and 32 is `EFC`) or `escape` (the `slic3rpe:*` attributes and the facets JSON, where 17 and up are E and an 8-bit value, so 32 is `0FEC`).

### Changed

- `decodeTree`, `paintTextLeafCount` and the paint overlay read each text on its own and refuse one that runs out or is not upper-case hex. Before, lower case was read. Codes past a whole tree are still ignored, and the new `paintTextLeftOver` counts them. A state above 32 reads as unpainted.

### Fixed

- `encodeTree` writes filament 18 as `0FC`: the leaf code C, then F and 0. It wrote `FC`, and in the `paint_color` format an F after C starts a longer state, so a reader of filaments above 17 took the next code of the text as part of it. `decodeTree` and the paint overlay read a run of F codes, each adding 15, and still read a whole text of `FC` as filament 18.
- On a phone, a one-finger drag on the selected model moves it on its plate only. The edge drag to another plate stays on the X and Y move arrows, and mouse, pen and tablet drags keep it.
- A model added beside the others fades all the way in. The frame loop stopped after the fade's first frame when nothing else asked for a frame, so the new model could stay invisible until something redrew the view.

## [0.2.7] - 2026-10-30

### Added

- `setEdgeDrag(hook)` lets a host take parts past the bed's edges while they move, for sending them to another plate. With a hook set, a move drag (and a touch drag on an X or Y move arrow) may take the footprint past each edge as far as the hook's `reachMm()`, and the hook hears the start, each move and the release. A footprint released all on the bed is a normal move. Past an edge the hook answers `'commit'` (the host took the parts away) or `'back'`, and the parts ease back to where the move started with no transform reported. Without a hook, moves stay on the bed as before.
- `cancelDrag()` calls off a running move or move arrow drag and puts the parts back, for Esc.
- `setDragZoom(scale)` eases the camera out by `scale` from where it is, and `setDragZoom(null)` eases it back, so a drag has room to leave the bed. An optional `shift` slides the view by a screen distance as well, to give one side the room.
- `keepCamera(change)` runs `change` with the camera held: a plate swapped in, a selection or a view preset asked for during it keeps the framing.
- `showSelection({ keepZoom: true })` moves the view sideways to a selection that is out of sight, keeping the distance and the angle.
- `placeReadout(x, y)` moves the distance readout beside the pointer during a move, so a host can keep it clear of its own marks.
- `@slicerx/viewport/edge-drag`: drag a part past a bed edge to send it to another plate, turned on with `enableEdgeDrag(viewport, options)`. The host lists its plates, says which one shows, and does the move (and its undo) for `{ plate }` or `'new'`; optional `dropTarget`, `notify`, `obstacles`, `onSwitch` and `canMove` fit it to the host's plate bar and toolbars. On a phone the view slides toward the side a finger's part heads for, so the line arms with the part and the finger on screen, and a drop with no plate bar shows the plate at once in the same framing with a short "Moved to Plate 4" note. Colors are the `--sx-edge-*` custom properties (or the `theme` option), which default to the viewport's own tokens, and every string can be replaced through `labels`. The gesture code loads on the first part drag, and nothing runs, listens or draws while no part moves. See "Drag to another plate" in the README.

### Changed

- Copies of one object share their geometry. Every part built from the same position and index arrays draws one creased mesh and one set of feature edges, and copies differ only by their transform, material and selection. A big part's worker build runs once for all its copies. The geometry is freed when its last copy goes, and a copy whose arrays differ (scaled or painted) still gets its own.

### Fixed

- With a mesh worker, the bead shader warm-up now waits until big parts have their final geometry. It could start right after the stand-ins drew, and on software GL the swap to the final geometry then waited for its compiles: a task of about 1 s in 6 of 7 opens of a 10-object, 1.3 million triangle plate. Now the longest task is about 0.16 s, and the warm-up, run once the GPU has nothing else to do, holds the page for about 0.06 s instead of 0.2 to 1 s.

## [0.2.6] - 2026-10-29

## [0.2.5] - 2026-10-29

## [0.2.4] - 2026-10-26

## [0.2.3] - 2026-10-25

## [0.2.2] - 2026-10-25

## [0.2.1] - 2026-10-24

### Fixed

- A pane sliding beside the view sizes the canvas buffer once, where it stops. On a busy machine the slide could draw no frame for longer than the resize wait, and the buffer was sized for a box a few px short of the end, then again for the final one.

## [0.2.0] - 2026-10-22

### Added

- Handle scene colors `axisX`, `axisY`, `axisZ`, `axisUniform`, `handleHot`, `handlePinned` and `handleHalo`: the move arrows, rotate rings and scale handles take their colors from the theme instead of fixed values.

### Changed

- Medium parts' creases and edges are built off the main thread.

### Fixed

- Move, rotate and scale handles read on every bed. Each one draws over a thin near black outline, and every handle color is at least 9:1 off it, so the fill or the outline keeps 3:1 against anything behind a handle: a light or dark studio, any plate surface, a part's shadow or the part itself. Before, the fills fell to about 1.1:1 on the light studio and the PEI surfaces. The X and Z colors and the pinned gray are lighter for this, and the handles draw fully opaque.

## [0.1.8] - 2026-10-18

### Added

- `setTheme` also takes a full theme from `createTheme` (@slicerx/ui) and applies its scene colors (`sceneFromUiTheme`, the same derivation as the embed's `sceneFor`). A value of any other shape logs a warning and keeps the current look instead of throwing. `viewportThemeOf` and the `UiThemeLike` type are exported.
- `stats().degrade`: how many times the view lowered its quality, and when it last did (`lastAt`, UTC ISO 8601).
- `originPlane` and `addPreview` scene colors: Create Sketch's origin planes and the material a Model operation adds in its preview. Unset, both follow `selection`, so a theme's accent now reaches them instead of the fixed purple.

### Fixed

- A paint overlay stays in front of its own part for every part of an object. Painted areas on the third and later parts of an object were drawn behind the model.

## [0.1.7] and earlier

### Added

- `meshWorker` option and the `@slicerx/viewport/mesh-worker` entry: parts of 200,000 triangles or more build their creased normals and feature edges in workers, after a smooth shaded stand-in shows at once; `platerefined` event and `stats().refiningParts`.
- The plate reveal: on the first plate a window shows, the outline is traced from the front, the hit blooms and the grid lays down back to front, about 2 s. Later views, reduced motion and software graphics draw the plate at once; `reveal: false` turns it off.
- Packaging for npm: a library build (`dist/index.js`, `dist/palette.js`, `dist/summary.js`) with three external and the SXPV reader bundled, self-contained type declarations, and `readPreview` re-exported so a page can load a `.sxpv` file with this package alone.
- The viewport: Prepare mode with plate, transform, cut, paint, sketch and push and pull tools, and Preview mode with instanced SXPV toolpaths, color schemes and legends.
