// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Wipe, tool change and pause markers for the viewport, from the G-code text: each sits where the nozzle is when
// the command runs, on the layer the line belongs to. Loaded with the first of those markers turned on.
import type { Host, PreviewBuffers } from '@slicerx/contracts'
import { layerOfSegment, segmentOfLine } from './gcode-lines'
import { scanMarks, type GcodeMark, type GcodeMarks } from './gcode-parse'
import { holdText } from './gcode-source'

export type MarkerPositions = Record<keyof GcodeMarks, Float32Array>

/**
 * x, y, z per marker. A wipe belongs to the move before it; a tool change or pause runs before the next move,
 * so it shows on that move's layer (a pause at a layer change shows on the layer it waits to print).
 */
export function positionsOf(p: PreviewBuffers, marks: GcodeMarks): MarkerPositions {
  const place = (list: GcodeMark[], after: boolean): Float32Array => {
    const out = new Float32Array(list.length * 3)
    let n = 0
    for (const m of list) {
      out[n++] = m.x
      out[n++] = m.y
      if (p.extrasOffset < 0) {
        // No line numbers (a slice stitched from parallel parts): the layer whose top is at the nozzle height.
        out[n++] = m.z
        continue
      }
      let seg = segmentOfLine(p, m.line)
      if (after && seg + 1 < p.segmentCount) seg += 1
      if (seg < 0) seg = 0
      out[n++] = p.layerZ[layerOfSegment(p, seg)] ?? 0
    }
    return out
  }
  return { wipes: place(marks.wipes, false), toolChanges: place(marks.toolChanges, true), pauses: place(marks.pauses, true) }
}

const cache = new WeakMap<PreviewBuffers, Promise<MarkerPositions>>()

/** Marker positions for what Preview shows, read once per preview. */
export function markerPositions(host: Host, p: PreviewBuffers): Promise<MarkerPositions> {
  const hit = cache.get(p)
  if (hit) return hit
  const empty = { wipes: new Float32Array(0), toolChanges: new Float32Array(0), pauses: new Float32Array(0) }
  const hold = holdText(host)
  const out = hold.source ? hold.source.then((src) => scanMarks(src)).then((marks) => positionsOf(p, marks)) : Promise.resolve(empty)
  void out.then(hold.release, hold.release)
  cache.set(p, out)
  out.catch(() => cache.delete(p))
  return out
}
