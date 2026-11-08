// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How long one geometry engine call may run before its host stops it. The engine runs a call synchronously and reads no
// messages meanwhile, so a call stuck in it (a join that stops making progress) would otherwise hold every call queued
// behind it, and a mimir run nobody watches, for good. The app's worker (packages/app/src/geom/client.ts) and the Node
// hosts (@slicerx/pilot/node) end the engine at the limit, send the calls queued behind it to a fresh one, and refuse the
// stuck call with geomStuckMessage.

/**
 * quick: picks, measures, previews, sketch solving and other answers a person waits on at the pointer. model: builds
 * and joins solids (an array, a boolean, a fillet, a push), and each step of a history replay. mesh: whole mesh work
 * whose time grows with the triangle count (import, a project read, repair, simplify, hollow, orient, paint, layer
 * plan).
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

const QUICK = /^(measure|measure\.feature|info|section|face\.pick|edge\.pick|shape\.profile|hole\.find|thread\.find|text\.polygons|emboss\.polygons|paint\.select|orient\.analyze|engine\.(core|full)|nest\.(footprint|start|step|end)|dimension\.[a-z.]+|sketch\.(solve|snaps|check|trim|extend|offset|mirror|fillet|chamfer|pattern|svg)|brep\.count)$|\.preview$/
const MESH = /^(import(\..+)?|cut|format\.[a-z0-9.]+|repair|remesh|simplify|hollow|split|orient\.rank|paint\.(regions|texture)|render|layers\.plan|resume|calibrate|nest\.arrange|fit\.check)$/

/** The class of an engine operation; an operation not listed is a model call. */
export function geomOpClass(op: string): GeomOpClass {
  if (QUICK.test(op)) return 'quick'
  if (MESH.test(op)) return 'mesh'
  return 'model'
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
 * The refusal of a call stopped at its limit: which step, and a smaller version to try. The same call sent again would
 * stop the same way.
 */
export function geomStuckMessage(op: string, limitMs: number): string {
  const smaller = geomOpClass(op) === 'mesh' ? 'a coarser mesh (simplify it first)' : 'fewer copies or a simpler part'
  return `the ${op} step ran past its ${said(limitMs)} limit and was stopped; try a smaller version: ${smaller}`
}
