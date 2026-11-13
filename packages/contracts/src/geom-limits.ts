// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How long one geometry engine call may run before its host stops it. The engine runs a call synchronously and reads no
// messages meanwhile, so a call stuck in it (a join that stops making progress) would otherwise hold every call queued
// behind it, and a mimir run nobody watches, for good. The app's worker (packages/app/src/geom/client.ts) and the Node
// hosts (@slicerx/pilot/node) end the engine at the limit, send the calls queued behind it to a fresh one, and refuse the
// stuck call with geomStuckMessage.

/**
 * quick: picks, measures, previews, sketch solving and other answers a person waits on at the pointer. model: builds
 * and joins solids (an array, a boolean, a fillet, a push), and each modeling step of a history replay. mesh: whole
 * mesh work whose time grows with the triangle count (import, a project read, repair, simplify, hollow, orient, paint,
 * layer plan).
 */
export type GeomOpClass = 'quick' | 'model' | 'mesh'

/**
 * Each class's limit, from the engine's web build timed in Node: about 4,700 calls recorded from the app's modeling
 * tests, plus big meshes and big merged arrays.
 * quick: p99 30 ms; the slowest, a 2 million triangle info, 0.8 s. model: p99 166 ms over the recorded calls; a merged
 * array of 16 copies of a 131,000 triangle sphere, still inside the join's work budget, took 45 s, and one of 40
 * copies reached the budget and was refused by the engine at 44 s, so the limit leaves that refusal room on a machine
 * four times slower. mesh: 2 million triangles took 18.7 s to simplify, 3 s to repair or cut, 1 s to hollow.
 */
export const GEOM_CALL_LIMIT_MS: Readonly<Record<GeomOpClass, number>> = {
  quick: 30_000,
  model: 180_000,
  mesh: 300_000,
}

/**
 * Each operation's class and the name a person knows its step by (the tool's label in the app): the engine's operations
 * (packages/geom/src/json.rs), the app worker's own (engine start, history replay) and those of the history steps a
 * replay runs. A test checks every engine operation is listed here, so a new one gets its class on purpose. An
 * operation not listed is a model call with no name of its own; one a person never runs as a step (the engine's own
 * start) has a class and no name, so its refusal says "This step".
 */
const STEPS: Readonly<Record<string, readonly [GeomOpClass, string?]>> = {
  // answers at the pointer
  info: ['quick', 'Mesh info'],
  section: ['quick', 'Section'],
  'paint.select': ['quick', 'Paint selection'],
  'orient.analyze': ['quick', 'Orientation check'],
  measure: ['quick', 'Measure'],
  'measure.feature': ['quick', 'Measure'],
  'face.pick': ['quick', 'Face pick'],
  'edge.pick': ['quick', 'Edge pick'],
  'shape.profile': ['quick', 'Shape outline'],
  'text.polygons': ['quick', 'Text outline'],
  'face.push.preview': ['quick', 'Push and pull preview'],
  'edge.fillet.preview': ['quick', 'Fillet preview'],
  'edge.chamfer.preview': ['quick', 'Chamfer preview'],
  'sketch.check': ['quick', 'Sketch'],
  'sketch.curves': ['quick', 'Sketch'],
  'sketch.snaps': ['quick', 'Sketch'],
  'sketch.solve': ['quick', 'Sketch'],
  'sketch.offset': ['quick', 'Sketch offset'],
  'sketch.project': ['quick', 'Sketch projection'],
  'sketch.fillet': ['quick', 'Sketch fillet'],
  'sketch.chamfer': ['quick', 'Sketch chamfer'],
  'sketch.svg': ['quick', 'Sketch from SVG'],
  'sketch.trim': ['quick', 'Sketch trim'],
  'sketch.extend': ['quick', 'Sketch extend'],
  'sketch.mirror': ['quick', 'Sketch mirror'],
  'sketch.pattern': ['quick', 'Sketch pattern'],
  'dimension.anchor': ['quick', 'Dimension'],
  'dimension.evaluate': ['quick', 'Dimension'],
  'hole.find': ['quick', 'Hole search'],
  'thread.find': ['quick', 'Thread search'],
  'nest.footprint': ['quick', 'Arrange'],
  'nest.start': ['quick', 'Arrange'],
  'nest.step': ['quick', 'Arrange'],
  'nest.end': ['quick', 'Arrange'],
  'brep.count': ['quick', 'Solid info'],
  'brep.info': ['quick', 'Solid info'],
  'brep.free': ['quick', 'Solid free'],
  'exact.ops': ['quick', 'Solid info'],
  'exact.kernel': ['quick', 'Solid info'],
  'engine.core': ['quick'],
  'engine.full': ['quick'],
  // building and joining solids
  build: ['model', 'Build'],
  subtract: ['model', 'Subtract'],
  interference: ['model', 'Interference check'],
  boolean: ['model', 'Join'],
  array: ['model', 'Array'],
  'array.merged': ['model', 'Array'],
  'shape.extrude': ['model', 'Extrude'],
  'text.mesh': ['model', 'Text'],
  emboss: ['model', 'Emboss'],
  'emboss.polygons': ['model', 'Emboss'],
  'extrude.svg': ['model', 'SVG extrude'],
  'face.push': ['model', 'Push and pull'],
  'sketch.revolve': ['model', 'Revolve'],
  'sketch.loft': ['model', 'Loft'],
  'sketch.sweep': ['model', 'Sweep'],
  'sketch.trace': ['model', 'Image trace'],
  'edge.fillet': ['model', 'Fillet'],
  'edge.chamfer': ['model', 'Chamfer'],
  'hole.apply': ['model', 'Hole'],
  'thread.apply': ['model', 'Thread'],
  shell: ['model', 'Shell'],
  mirror: ['model', 'Mirror'],
  pattern: ['model', 'Pattern'],
  'parts.add': ['model', 'Add parts'],
  'parts.order': ['model', 'Reorder parts'],
  'parts.slot': ['model', 'Part filament'],
  'brep.box': ['model', 'Solid shape'],
  'brep.cylinder': ['model', 'Solid shape'],
  'brep.primitive': ['model', 'Solid shape'],
  'brep.extrude': ['model', 'Extrude'],
  'brep.boolean': ['model', 'Join'],
  'brep.subtract': ['model', 'Subtract'],
  'brep.cut': ['model', 'Cut'],
  'brep.fillet': ['model', 'Fillet'],
  'brep.chamfer': ['model', 'Chamfer'],
  'brep.push': ['model', 'Push and pull'],
  'brep.hole': ['model', 'Hole'],
  'brep.tessellate': ['model', 'Solid to mesh'],
  'brep.save': ['model', 'Solid save'],
  'brep.load': ['model', 'Solid load'],
  'history.replay': ['model', 'History replay'],
  // work over a whole mesh
  render: ['mesh', 'Render'],
  'paint.regions': ['mesh', 'Paint'],
  'paint.texture': ['mesh', 'Texture paint'],
  paint: ['mesh', 'Paint'],
  cut: ['mesh', 'Cut'],
  'plane.cut': ['mesh', 'Cut'],
  split: ['mesh', 'Split to fit'],
  repair: ['mesh', 'Repair'],
  'orient.rank': ['mesh', 'Auto orient'],
  hollow: ['mesh', 'Hollow'],
  calibrate: ['mesh', 'Calibration model'],
  resume: ['mesh', 'Resume from a layer'],
  'layers.plan': ['mesh', 'Layer plan'],
  import: ['mesh', 'Import'],
  'import.auto': ['mesh', 'Import'],
  'import.selfIntersections': ['mesh', 'Import check'],
  remesh: ['mesh', 'Remesh'],
  simplify: ['mesh', 'Simplify'],
  'fit.check': ['mesh', 'Fit check'],
  'nest.arrange': ['mesh', 'Arrange'],
  'format.read3mf': ['mesh', 'Project open'],
}

/** The class of an engine operation; an operation not listed is a model call. */
export function geomOpClass(op: string): GeomOpClass {
  return STEPS[op]?.[0] ?? 'model'
}

/** The name a person knows the step of `op` by ("Array", "Push and pull"), or none for an operation not listed. */
export function geomStepName(op: string): string | undefined {
  return STEPS[op]?.[1]
}

/** How long a call of `op` may run in the engine. */
export function geomCallLimitMs(op: string): number {
  return GEOM_CALL_LIMIT_MS[geomOpClass(op)]
}

/** A limit in plain seconds or minutes: "0.5 s", "30 s", "3 min". */
function said(ms: number): string {
  if (ms >= 120_000 && ms % 60_000 === 0) return `${ms / 60_000} min`
  return `${Number((ms / 1000).toFixed(1))} s`
}

/**
 * The refusal of a call of `op` stopped at its limit: the step by the name a person knows it by (`name`, such as a
 * history step's own, else the operation's), and what to try for its class. The same call sent again would stop the
 * same way, so model and mesh work suggest a smaller version; a quick answer is worth asking for again.
 */
export function geomStuckMessage(op: string, limitMs: number, name: string | undefined = geomStepName(op)): string {
  const step = name ? `The step "${name}"` : 'This step'
  const cls = geomOpClass(op)
  if (cls === 'quick') return `${step} took too long (over its ${said(limitMs)} limit) and was stopped; try it again`
  const smaller = cls === 'mesh' ? 'a coarser mesh' : 'fewer copies or a simpler part'
  return `${step} ran past its ${said(limitMs)} limit and was stopped; try a smaller version: ${smaller}`
}

/** Whether a refusal (an error's or a failed tool's words) is one of geomStuckMessage's. */
export function isGeomStuck(text: string): boolean {
  return isGeomStuckFinal(text) || /took too long \(over its [0-9.]+ (s|min) limit\) and was stopped; try it again/.test(text)
}

/**
 * Whether a refusal is geomStuckMessage's for model or mesh work: the same call would stop the same way, so only a
 * smaller version, or the same call on a part made smaller, is worth running. A quick step's refusal says to try it
 * again.
 */
export function isGeomStuckFinal(text: string): boolean {
  return /ran past its [0-9.]+ (s|min) limit and was stopped; try a smaller version/.test(text)
}
