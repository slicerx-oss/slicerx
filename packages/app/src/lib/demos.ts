// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tooltip demo loops, by id: each is a stage loop (packages/ui tooltip-stage), a module under ../demos that loads
// when a tip first shows it. A loop's sentence is the tip's text when the anchor has none of its own.
// To add a loop: write ../demos/<id>.ts (a `loop: StageTool`, drawn by the loop builder), add one entry to OWN below
// (its id, the module import, the sentence), then point a tip at it: `demo: '<id>'` on a registry tip or tipAttrs,
// or data-tip-demo="<id>" on the anchor. Dark and light come from the stage tokens, and the finished frame (shown
// paused before the loop plays, and under reduced motion) is the poster, so an entry needs no other files.
import type { StageDemo, TipDemo } from '@slicerx/ui'

const demo = (stage: StageDemo['stage'], label: string): TipDemo => ({ stage, label, body: label })

const OWN = {
  push: demo(() => import('../demos/push').then((m) => m.loop), 'Drag a face to push or pull it. Hold Shift to snap in 1 mm steps.'),
  sketch: demo(() => import('../demos/sketch').then((m) => m.loop), 'Draw a shape on a face, then pull it up into a solid.'),
  face: demo(() => import('../demos/face').then((m) => m.loop), 'Place text or a shape on any face, then raise it out or cut it in.'),
  add: demo(() => import('../demos/add').then((m) => m.loop), 'Drop a box, cylinder or other shape onto the plate.'),
  fillet: demo(() => import('../demos/fillet').then((m) => m.loop), 'Pick an edge and drag to round it. The radius shows in mm.'),
  shell: demo(() => import('../demos/shell').then((m) => m.loop), 'Pick a face to open and the part is hollowed, with even walls in mm.'),
  subtract: demo(() => import('../demos/subtract').then((m) => m.loop), 'Push one shape into another to cut its form out.'),
  cut: demo(() => import('../demos/cut').then((m) => m.loop), 'Split a part with a plane, then move each half on its own.'),
  array: demo(() => import('../demos/array').then((m) => m.loop), 'Drag to copy a part in a row. Each step adds one copy.'),
  holefit: demo(() => import('../demos/hole').then((m) => m.loop), 'Pick a hole and refit it for a screw, a heat-set insert or a bolt.'),
  thread: demo(() => import('../demos/thread').then((m) => m.loop), 'Add a real thread to a post or a hole, sized like M10 × 2.'),
  mesh: demo(() => import('../demos/mesh').then((m) => m.loop), 'Reduce a mesh to fewer triangles while it keeps its shape.'),
  sleipnir: demo(() => import('../demos/sleipnir').then((m) => m.loop), 'sleipnir lays thinner layers where a curve needs them, down to 0.08 mm, and thick ones elsewhere.'),
  aegis: demo(() => import('../demos/aegis').then((m) => m.loop), 'aegis lets walls narrow to fill thin tips, so no gap is left unprinted.'),
  atlas: demo(() => import('../demos/atlas').then((m) => m.loop), 'atlas moves the prime tower off your parts to a clear spot on the plate.'),
  heimdall: demo(() => import('../demos/heimdall').then((m) => m.loop), 'heimdall plays the print back move by move, tool changes included.'),
  norn: demo(() => import('../demos/norn').then((m) => m.loop), 'Pick a line in the toolpaths and norn shows the setting behind it, ready to change.'),
  // the settings in Simple and the model tools: one module per loop, siblings share a drawing and pick out their value
  'layer-height': demo(() => import('../demos/layer-height').then((m) => m.loop), 'Sets the layer height, from 0.28 mm for quick prints to 0.08 mm for smooth curves and slopes.'),
  strength: demo(() => import('../demos/strength').then((m) => m.loop), 'Adds walls and infill, from 2 walls and 10% infill up to 6 walls and 40%.'),
  'infill-density': demo(() => import('../demos/infill-density').then((m) => m.loop), 'How much of the inside is filled, in percent. Higher is stronger and heavier, and takes longer to print.'),
  'wall-loops': demo(() => import('../demos/wall-loops').then((m) => m.loop), 'How many outlines each layer gets. More loops make stronger, heavier parts and take longer.'),
  speed: demo(() => import('../demos/speed').then((m) => m.loop), 'How fast the printer moves, from 50 to 166 percent of the preset speeds.'),
  'speed-quality': demo(() => import('../demos/speed-quality').then((m) => m.loop), '50 percent of the preset speeds.'),
  'speed-balanced': demo(() => import('../demos/speed-balanced').then((m) => m.loop), 'The preset speeds.'),
  'speed-fast': demo(() => import('../demos/speed-fast').then((m) => m.loop), '124 percent of the preset speeds.'),
  'speed-fastest': demo(() => import('../demos/speed-fastest').then((m) => m.loop), '166 percent of the preset speeds.'),
  supports: demo(() => import('../demos/supports').then((m) => m.loop), 'Holds up overhangs that would otherwise print in mid-air.'),
  'supports-off': demo(() => import('../demos/supports-off').then((m) => m.loop), 'No supports.'),
  'supports-auto': demo(() => import('../demos/supports-auto').then((m) => m.loop), 'Organic tree supports where the model needs them.'),
  'supports-painted': demo(() => import('../demos/supports-painted').then((m) => m.loop), 'Only where you paint support.'),
  'enable-support': demo(() => import('../demos/enable-support').then((m) => m.loop), 'Builds removable support under overhangs that would otherwise print in mid-air.'),
  brim: demo(() => import('../demos/brim').then((m) => m.loop), 'Adds flat rings around the first layer to hold the part to the bed.'),
  'brim-type': demo(() => import('../demos/brim-type').then((m) => m.loop), 'An all-around brim, or mouse ears: small discs under sharp corners only.'),
  'history-suppress': demo(() => import('../demos/history-suppress').then((m) => m.loop), 'Leave this step out and run the rest without it; click again to bring it back.'),
  'history-view': demo(() => import('../demos/history-view').then((m) => m.loop), 'See the part as it was right after this step; click again to return to the latest.'),
  'history-earlier': demo(() => import('../demos/history-earlier').then((m) => m.loop), 'Run this step before the one above it; the steps run again and say if one no longer works.'),
  'history-later': demo(() => import('../demos/history-later').then((m) => m.loop), 'Run this step after the one below it; the steps run again and say if one no longer works.'),
  'keep-dimension': demo(() => import('../demos/keep-dimension').then((m) => m.loop), 'Keep the measurement on the model, so it updates after each edit.'),
  'mirror-x': demo(() => import('../demos/mirror-x').then((m) => m.loop), 'Flip the object across the X axis.'),
  'mirror-y': demo(() => import('../demos/mirror-y').then((m) => m.loop), 'Flip the object across the Y axis.'),
  'mirror-z': demo(() => import('../demos/mirror-z').then((m) => m.loop), 'Flip the object across the Z axis.'),
  'print-sequence': demo(() => import('../demos/print-sequence').then((m) => m.loop), 'By layer prints all parts together; by object finishes each part before starting the next.'),
  'whole-loop': demo(() => import('../demos/whole-loop').then((m) => m.loop), 'Add every edge around the face the last pick was on.'),
  'drop-to-bed': demo(() => import('../demos/drop-to-bed').then((m) => m.loop), 'Lower the model until it touches the bed.'),
  'round-corners': demo(() => import('../demos/round-corners').then((m) => m.loop), 'Round or bevel corners between two straight lines of the picked loop.'),
  'brim-ears': demo(() => import('../demos/brim-ears').then((m) => m.loop), 'Click the model to put a brim ear under it, right click an ear to remove it.'),
  move: demo(() => import('../demos/move').then((m) => m.loop), 'Drag the model across the plate.'),
  'lay-on-face': demo(() => import('../demos/lay-on-face').then((m) => m.loop), 'Pick a face to put flat on the bed.'),
  rotate: demo(() => import('../demos/rotate').then((m) => m.loop), 'Drag a ring to turn the model around that axis. Hold Shift to turn in 15° steps.'),
  scale: demo(() => import('../demos/scale').then((m) => m.loop), 'Resize the model, uniformly or per axis.'),
} satisfies Record<string, TipDemo>

/** The loops by id; a tool that shares another's loop (a shape, text or SVG on a face; simplify) names it too. */
export const DEMOS: Readonly<Record<string, TipDemo>> = { ...OWN, facesvg: OWN.face, facetext: OWN.face, shape: OWN.face, simplify: OWN.mesh }

/** Settings whose row tip shows a loop, by setting key. */
export const SETTING_DEMOS: Readonly<Record<string, string>> = {
  layer_height: 'layer-height',
  sparse_infill_density: 'infill-density',
  wall_loops: 'wall-loops',
  enable_support: 'enable-support',
  brim_width: 'brim',
  combine_brims: 'brim',
  brim_type: 'brim-type',
  print_sequence: 'print-sequence',
}
