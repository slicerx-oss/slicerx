# @slicerx/viewport

Framework-free three.js viewport that owns its render loop and scene graph. WebGL2 today. Prepare mode draws product-shot models; Preview mode draws instanced SXPV toolpaths. React talks to it through an imperative handle and events, never by re-rendering per frame.

```ts
const vp = createViewport(canvas, { controls: 'slicerx', theme, quality: 'high' })
```

## Install

```sh
npm install @slicerx/viewport
```

The package is ES modules for the browser, with type declarations. It depends on `three` 0.186; use the same version if your page also imports three, so there is one copy. It needs WebGL2.

Show the toolpath preview of a slice, for example the `slice.sxpv` that `sx slice --request <file> --out-dir <dir>` writes:

```ts
import { createViewport, readPreview } from '@slicerx/viewport'

const canvas = document.querySelector('canvas')!
const vp = createViewport(canvas, { controls: 'slicerx', quality: 'high' })
const preview = readPreview(await (await fetch('/out/slice.sxpv')).arrayBuffer())
vp.setMode('preview')
vp.setPreview(preview)
vp.setLayerRange(0, preview.layerCount - 1)
vp.view('iso')
// Call vp.dispose() when the canvas goes away.
```

The sections below list every call. [THEMING.md](THEMING.md) covers colors and themes. `@slicerx/embed` in the repository wraps the viewport as a React component and a custom element.

## License

Apache-2.0 (`LICENSE-APACHE`, `NOTICE`; keep the "Made possible by SlicerX" credit). The package bundles the SXPV reader from `@slicerx/contracts` and contains no printer profile data.

## Prepare

- Plate: `setPlate`, `setTransforms`, `setSelection`, `arrange`, `setTool('select' | 'move' | 'rotate' | 'face' | 'paint' | 'scale')`.
- Bed: `setExcludedAreas(polygons)` (or `ViewportPlate.excluded`) hatches the parts of the bed nothing may print on, the printer's `bed_exclude_area`, in bed coordinates. Drawn once on the floor; nothing about it runs per frame.
- Scale: the `scale` tool follows the look's scale bindings, read from each app's source (Orca v2.4.2 and Bambu Studio GLGizmoScale.cpp, PrusaSlicer 3.0 ScaleGizmo.cpp; SlicerX follows Bambu Studio). Orca and Bambu Studio: x and y handles at the middle of the bottom edges, z on top, uniform handles at the bottom corners; a drag scales about the bottom center so the model stays on the bed; Ctrl pins the opposite handle (Orca reads it when the drag starts, Bambu Studio live; only Orca makes a pinned corner scale x and y only); Shift snaps to 5 percent; the ratio is taken from the ray plane (Orca) or the ray point nearest the handle (Bambu Studio). PrusaSlicer: a handle at each face center and corner handles at mid height, scales about the center, no modifier keys, keeps at least 1 mm. Orca's Alt (independent scaling) only matters for several selected models, which the viewport does not scale. The `scale` event reports the factors, `transform` events carry the matrix (`final: true` on release), and `scaleHandles()` gives the handle positions on screen. Move snaps to 1 mm with Shift in Orca and Bambu Studio.
- Rotate: the `rotate` tool draws one ring per axis around the selected model's box center, as Orca's GLGizmoRotate3D does. Dragging a ring turns the model by the angle the cursor sweeps around the center (by its travel along the ring when the ring is seen edge on); the swept sector and the angle show while dragging. The look's rotate snap key (Shift on every look; Orca, Bambu Studio and PrusaSlicer snap by ring zones instead) steps by 15 degrees. `setRotateSpace('world' | 'local')` turns about the bed's axes or the model's own. A turn about a tilted axis puts the model back on the bed on release. The `rotate` event reports the angle, `transform` events the matrix, and `rotateHandles()` a grab point on each ring.
- Cut: `setCutPlane({ objectId, point, normal, keep })` puts a plane on the model, after Orca's GLGizmoCut3D: dragging the plane or the grabber on its stem moves it along the normal (kept within the model), the two rings tilt it, and the rotate snap key steps by 1 mm and 15 degrees. The model is clipped at the plane: the side `keep` drops draws faint. Clipping planes are uniforms, so a drag rewrites no geometry. The `cutplane` event reports the plane (`final: true` on release); `cutHandles()` gives the grabber and ring points on screen. `null` ends it.
- Push and pull (with the `probe` tool): `setPush({ face, distanceMm, prism })`. A press on a flat face and a drag move it along its normal (the rotate snap key rounds to 1 mm); a click still emits `pick`. The view stretches `prism`, the swept prism of a 1 mm push, to the distance with one matrix, green when it adds and red when it cuts, so a drag builds no geometry. The `push` event reports `start`, `move`, `end` or `cancel` with the distance.
- Sketch (with the `probe` tool): `setSketch({ frame, paths, handles, dragHandles, grid, marks })` draws flat geometry on a plane (src/cadtools.ts); `setSketchCursor({ path, at, guide })` rewrites the rubber band in a fixed buffer. The `sketch` event reports the cursor in plane coordinates at most once a frame (`hover`), clicks, right clicks (`context`) and handle drags. `lookAtPlane(point, normal, radiusMm)` turns the camera square onto a plane.
- Kept dimensions: `setDimensions([{ id, from, to, label }])` draws leader lines and value labels as sprites, so orbiting runs no code for them.
- Looks: `setRenderMode('studio' | 'clay' | 'xray' | 'overhang' | 'filament')`, `setDisplayStyle('shaded' | 'edges' | 'wireframe')`, `setOverhangAngle`, `setPrintLook`.
- Views: `view('iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'fit' | 'bed')`, `zoomToSelection()`, `zoomToBed()`, `focusBedPoint(x, y, z)` (eases to center a bed point at the current angle and zoom; jumps under reduced motion), `setProjection('perspective' | 'orthographic')`, `toggleProjection()`. Keys are bound by the app.
- Lay on face: with the `face` tool the flat face under the cursor is highlighted and `facepick` fires on click with `{ objectId, normal, centerBed, areaMm2, point }`. `pickFace(x, y)` does the same without the tool. `layOnFaceTransform(transform, normal, centerBed)` returns the rotated transform; drop the model onto the bed after.

- Modeling tools: with `setTool('probe')` a click only reports what is under the cursor. `pick` carries the object, the part, the bed point, the `triangle` (index into the part's index buffer) and `bed` (where the click meets the bed plane); nothing is selected or dragged. `setProbeFaces(true)` highlights the flat face under the cursor. `setGuides({ lines, loops, points })` draws measured end points, face outlines and shape profiles in bed coordinates; `{}` clears them.

## Painting

`setTool('paint')` turns on the paint tools; `setPaintSettings({ layer, tool, shape, radiusMm, state, erase, splitTriangles, detailMm, angleDeg, heightRangeMm })` configures them.

- Layers: `color` (state is the 1-based filament slot, colors from `setPaintColors`), `seam` and `support` (1 enforcer, 2 blocker), and `fuzzy` (1 painted fuzzy skin; the right button erases).
- Tools, per look (Orca and Bambu Studio GLGizmoPainterBase.cpp and TriangleSelector.cpp, PrusaSlicer PaintOnGizmoBase.cpp): `brush` (sphere or circle; the dab starts at the triangle under the pointer and spreads over neighbors that face the viewer, so nothing behind a thin wall or on a disconnected surface is painted; with `splitTriangles` the edge follows the cursor down to `radius / 5`, at most 0.05 mm in Orca and 0.2 mm in Bambu Studio, unless `detailMm` is set), `triangle` (the single piece under the pointer), `fill` (same-state pieces connected to the pointer, stopping at bends over `fillAngleDeg`), `smart` (whole triangles while neighbor normals stay within `angleDeg`), `height` (a band of `heightMm` on every part, starting at the pointer height in Orca and Bambu Studio and centered on it in PrusaSlicer), `gap` (Orca and Bambu Studio: `performGapFill(objectId)` merges patches under `gapAreaMm2` into a neighbor), `replace` (PrusaSlicer: every piece of the color under the pointer takes the new one). The left button paints and the erase key (Shift) erases. On the seam and support layers the left button writes an enforcer and the right button a blocker. On the color layer the right button is left to the camera in Orca and Bambu Studio and paints the second color (`secondState`) in PrusaSlicer. The wheel with the look's parameter key (Ctrl in Orca and Bambu Studio, Alt in PrusaSlicer) changes the radius, band, fill angle or gap area in the look's steps, and with the other key (Alt, Ctrl) moves the clipping plane: what lies in front of it is hidden and not painted, the ray can reach the inside of the cut model, and `clipRatio` and the `paintsettings` event carry it. `overhangOnlyDeg` paints only faces steeper than the angle. Cursors follow Orca: a translucent sphere (black at rest, blue with the left button, red with the right), a dashed green ring with a disc for the circle brush, and the cut of the model at the top and bottom of the band for the height tool. `erase: true` writes state 0.
- Data: `getPaintData(objectId, partIndex, layer)` returns the text of each painted triangle (index into the part's index buffer) in the format Bambu Studio and OrcaSlicer write as `paint_color`, `paint_seam`, `paint_supports` and `paint_fuzzy_skin`; `setPaintData` loads it. `encodeTree`, `decodeTree`, `paintTexts` and `readPaintTexts` are exported for readers and writers that run without a viewport. The child layout matches sx-core (`packages/core/src/paint.rs`), which was fitted to OrcaSlicer.
- Undo: each stroke, fill or height range emits `paintstroke` with `edits` (`before` and `after` text per triangle). Undo is `applyPaintEdits(..., edits.map(e => ({ triangle: e.triangle, text: e.before })))`.
- A stroke that crosses onto another part of the model reports one `paintstroke` per part.
- Limits: pieces split by a stroke do not split their neighbors, so painted regions can have T-junctions at borders; slicers read each triangle on its own.

## Preview

- `setPreview(buffers)`, `setLayerRange(lo, hi)`, `setMoveCut(moves)`, `layerMoveCount(layer)`, `setTravels(on)`. `currentMove()` gives the segment, layer and G-code line at the nozzle.
- Color schemes: `setColorMode('feature' | 'tool' | 'speed' | 'flow' | 'width' | 'height' | 'layerTime' | 'fan' | 'temperature')`. `previewRanges()` gives the value ranges for legends.
- Legend: `previewLegend()` lists the features present with color, time and length; `setFeatureVisible(id, on)` and `setVisibleFeatures(ids)` toggle them.
- Fan, nozzle temperature, retraction and seam markers come from the per-segment extras of the SXPV buffer when it has them (`previewExtras()` says what is loaded); `setPreviewExtras({ fanPct, nozzleC, retractions, seams })` supplies them by hand. `setMarkers({ retractions, seams, lifts, wipes, toolChanges, pauses })` shows the markers. Wipes, tool changes and pauses are not in SXPV v1: the app reads them from the G-code and passes positions to `setGcodeMarkers` (z on the layer the marker belongs to). Retractions, seams and lifts draw as discs, wipes as diamonds, tool changes and pauses as squares, so the kinds differ by shape as well as color (`scene.wipe`, `scene.toolChange`, `scene.pause`).

- Clicking a toolpath emits `pathpick` with the segment, layer, feature, tool, G-code line, the bed point and the screen position, or null for a click on nothing. Hidden layers and features cannot be hit (`Toolpaths.pick`, a ray against every drawn segment).
- `setPreviewGhost(buffers | null)` draws a second, faint set of toolpaths that follows the layer range: the slice before a change.

## Gizmo bindings and Settings

Every look's `ControlsMap` has a `gizmo` field (`scale`, `move`, `paint`) with the keys, steps, layouts and defaults above (src/gizmobindings.ts). The tools read it live. Settings edits it the same way as the camera: `setControls(withGizmo(CONTROL_PRESETS[id], { scale: { snapKey: 'alt' }, paint: { wheelParamKey: 'alt' } }))`; `withGizmoOverrides(base, overrides)` does the merge without a map, and `null` clears an optional key. Switching to another look resets the paint settings to that look's defaults.

## Controls and theme

- `setControls('slicerx' | 'bambu-studio' | 'prusaslicer' | 'orcaslicer' | ControlsMap)`, `withRemap` for per-button changes. The maps are data in `src/controls.ts` with tests.
- `setTheme(theme)`. Reference: THEMING.md.

## Checks

`pnpm --filter @slicerx/viewport test` and `typecheck`. `pnpm --filter @slicerx/viewport dev` runs the demo; `?controls=bambu-studio` picks a controls preset. Test against a built demo, not the dev server, when driving it from a browser: the dev server reloads the page whenever a workspace package changes.
- Brim ears (Orca's GLGizmoBrimEars): tool `'brim'`. A left click on a model emits `brimadd { objectId, point }` (bed frame, mm; not when it lands on an ear), a right click on an ear emits `brimremove { objectId, index }`. `setBrimEars({ [objectId]: [{ x, y, z, r, error? }] })` draws the ears as flat 0.2 mm discs on the bed (alert color for `error`); `setBrimHoverRadius(r | null)` shows a faint disc at the cursor. Unit tested; not yet driven in a browser.
- Brim ears, selection (Orca gizmo_event): ears take `selected` (highlight color). A click on an ear emits `brimselect { objectId, indices, mode: 'set' }`; Shift+click toggles it (`add` or `remove`), Alt+click removes. A click on the model while some ears are selected emits `brimselect` with no indices (`set`) instead of `brimadd`. Shift+drag draws a selection rectangle and Alt+drag a deselect rectangle; release emits `brimselect` with the ears whose centers are inside, per object (ears hidden behind the model are skipped, as in Orca's get_unobscured_idxs: the ear and a point just above it are ray tested). Dragging an ear emits `brimmove { objectId, index, point, final }` (the camera does not orbit). Ctrl+wheel emits `brimwheel { delta }` and does not zoom.
