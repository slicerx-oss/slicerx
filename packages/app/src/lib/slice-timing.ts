// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where the time of the last slice went, from the Slice click (or auto slice's start) to the first frame with its
// preview, for profiling and for the checks that keep slicing fast. Each stage is a performance measure
// `sx:slice:<stage>` from the start of the slice to the end of that stage, and `sliceTiming()` returns them (the agent
// bridge's app_state).
//
// Stages, in order:
//   ready     the profile is in step with the printer and the quality tier (and a project's G-code was asked about)
//   objects   the engine holds every object's mesh and the objects are placed (plateObjects)
//   request   the rest of the request is built (layer plan, height ranges, marks); the engine's call starts here
//   result    the engine's answer is back (the host's call: the request's way in, the slice, the report's way out)
//   preview   the preview's bytes are in the page
//   parsed    the preview is read into its typed arrays
//   shown     the slice and its preview are in the app's state
//   drawn     the 3D view has drawn a frame with the preview
// Besides the stages: `engineMs`, the engine's own time (the sum of its stage times), and `previewBytes`.

export type SliceStage = 'ready' | 'objects' | 'request' | 'result' | 'preview' | 'parsed' | 'shown' | 'drawn'

export interface SliceTiming {
  /** Milliseconds from the start of the slice to the end of each stage. */
  ms: Partial<Record<SliceStage, number>>
  /** The engine's own time, ms: its stage times summed. The rest of `result - request` is the way in and out. */
  engineMs?: number
  /** The size of the preview, bytes. */
  previewBytes?: number
  /** Whether auto slice started it. */
  auto: boolean
}

let current: (SliceTiming & { t0: number; id: number }) | null = null
let seq = 0

const perf = (): Performance | null => (typeof performance !== 'undefined' && typeof performance.measure === 'function' ? performance : null)
const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** Starts timing a slice; the previous slice's stages are dropped. Returns its number, for the stages that follow. */
export function sliceStarted(auto: boolean, now = clock()): number {
  const p = perf()
  if (p) for (const e of p.getEntriesByType('measure')) if (e.name.startsWith('sx:slice:')) p.clearMeasures(e.name)
  current = { ms: {}, auto, t0: now, id: ++seq }
  return seq
}

/** Ends a stage of slice `id`, the first time only. A stage of a slice that a newer one replaced is dropped. */
export function sliceStage(id: number, stage: SliceStage, extra: { engineMs?: number; previewBytes?: number; now?: number } = {}): void {
  const c = current
  if (!c || c.id !== id || c.ms[stage] !== undefined) return
  const now = extra.now ?? clock()
  c.ms[stage] = Math.round(now - c.t0)
  if (extra.engineMs !== undefined) c.engineMs = Math.round(extra.engineMs)
  if (extra.previewBytes !== undefined) c.previewBytes = extra.previewBytes
  try {
    perf()?.measure(`sx:slice:${stage}`, { start: c.t0, end: now })
  } catch {
    // A page without user timing still keeps the numbers.
  }
}

/** The number of the slice being timed (or last timed), or 0 before the first. */
export const currentSlice = (): number => current?.id ?? 0

/** The last slice's timing, or null before the first. */
export function sliceTiming(): SliceTiming | null {
  if (!current) return null
  const { ms, engineMs, previewBytes, auto } = current
  return { ms: { ...ms }, auto, ...(engineMs !== undefined ? { engineMs } : {}), ...(previewBytes !== undefined ? { previewBytes } : {}) }
}
