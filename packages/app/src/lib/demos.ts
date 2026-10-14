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
} satisfies Record<string, TipDemo>

/** The loops by id; a tool that shares another's loop (a shape, text or SVG on a face; simplify) names it too. */
export const DEMOS: Readonly<Record<string, TipDemo>> = { ...OWN, facesvg: OWN.face, facetext: OWN.face, shape: OWN.face, simplify: OWN.mesh }

/** Settings whose row tip shows a loop, by setting key. */
export const SETTING_DEMOS: Readonly<Record<string, string>> = {}
