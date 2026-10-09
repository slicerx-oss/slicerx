// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where the time of the last file open went, for profiling and for the checks that keep opening fast: each stage is a
// performance measure `sx:open:<stage>` from the start of the open to the end of that stage, so a trace shows them on
// the open's own timeline, and `openTiming()` returns them (the agent bridge's app_state, the browser tests).
//
// Stages, in the order a 3MF project passes them:
//   read      the file's bytes are in the page
//   unzip     the archive is inflated
//   parse     its meshes are typed arrays (in the project worker when there is one)
//   printer   the project's printer and its profile are set
//   engine    the engine holds every mesh (load_mesh)
//   objects   the objects are on the plate and the 3D view has built them
//   drawn     the 3D view has drawn a frame with them
//   settings  the project's settings are applied (the "Opened as" note is ready)
//   gcode     its printer G-code is checked
//   done      the open is over (the plate stops loading)
//   sliced    the slice that follows it is done
// A stage that did not happen in an open (a plain STL has no printer) is absent.

export type OpenStage = 'read' | 'unzip' | 'parse' | 'printer' | 'engine' | 'objects' | 'drawn' | 'settings' | 'gcode' | 'done' | 'sliced'

export interface OpenTiming {
  /** The file's name. */
  name: string
  /** Milliseconds from the start of the open to the end of each stage. */
  ms: Partial<Record<OpenStage, number>>
  /** Where the meshes were parsed. */
  parsedIn?: 'worker' | 'page'
}

let current: (OpenTiming & { t0: number; open: boolean }) | null = null

const perf = (): Performance | null => (typeof performance !== 'undefined' && typeof performance.measure === 'function' ? performance : null)

/** Starts timing an open; the previous open's stages are dropped. */
export function openStarted(name: string): void {
  const p = perf()
  if (p) for (const e of p.getEntriesByType('measure')) if (e.name.startsWith('sx:open:')) p.clearMeasures(e.name)
  current = { name, ms: {}, t0: typeof performance !== 'undefined' ? performance.now() : Date.now(), open: true }
}

/**
 * Ends a stage of the open in progress, the first time only; `drawn` and `sliced` may land after the open is over.
 * `at` is when the stage ended elsewhere (a worker), as performance.timeOrigin + performance.now() there.
 */
export function openStage(stage: OpenStage, extra?: { parsedIn?: OpenTiming['parsedIn']; at?: number }): void {
  const c = current
  if (!c || c.ms[stage] !== undefined) return
  if (!c.open && stage !== 'drawn' && stage !== 'sliced') return
  // A frame drawn before the open put its objects on the plate is not theirs.
  if (stage === 'drawn' && c.ms.objects === undefined) return
  const here = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const now = extra?.at !== undefined && typeof performance !== 'undefined' ? Math.min(here, extra.at - performance.timeOrigin) : here
  c.ms[stage] = Math.round(now - c.t0)
  if (extra?.parsedIn) c.parsedIn = extra.parsedIn
  try {
    perf()?.measure(`sx:open:${stage}`, { start: c.t0, end: now })
  } catch {
    // A page without user timing still keeps the numbers.
  }
}

/** The open is over (it finished or failed); only `drawn` and `sliced` are still taken. */
export function openEnded(): void {
  if (!current || !current.open) return
  openStage('done')
  current.open = false
}

/** The last open's timing, or null before the first. */
export function openTiming(): OpenTiming | null {
  if (!current) return null
  return { name: current.name, ms: { ...current.ms }, ...(current.parsedIn ? { parsedIn: current.parsedIn } : {}) }
}

/** The 3D view's start, once per page: from mounting it (before its code loads) to its first frame, and the viewport's own firstDrawMs (from creating it to that frame). */
export interface ViewTiming {
  mountToDrawMs: number
  firstDrawMs: number | null
}

let view: ViewTiming | null = null

/** Records the 3D view's first frame; later frames do not count. `mountedAt` is performance.now() when it mounted. */
export function viewDrawn(mountedAt: number, firstDrawMs: number | null): void {
  if (view || typeof performance === 'undefined') return
  const now = performance.now()
  view = { mountToDrawMs: Math.round(now - mountedAt), firstDrawMs: firstDrawMs === null ? null : Math.round(firstDrawMs) }
  try {
    perf()?.measure('sx:view:first-draw', { start: mountedAt, end: now })
  } catch {
    // A page without user timing still keeps the numbers.
  }
}

export function viewTiming(): ViewTiming | null {
  return view
}
