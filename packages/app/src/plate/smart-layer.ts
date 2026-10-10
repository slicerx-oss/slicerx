// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// sleipnir: sx-geom plans the layer tops for the whole plate (thin where the shape curves,
// thick where walls run straight, then smoothed), and the engine slices at exactly those heights.
// The plan runs in a geometry worker of its own (soloCall), so the fit check never waits behind it, and an edit that
// leaves everything the plan reads alone (speed, walls, infill, supports) reuses the last plan instead of asking again.
import type { PlateEntry } from '../state/store'
import { geom, soloCall, usesWorker, type GeomMesh } from '../geom/client'
import { bake } from './mesh-ops'

const num = (v: unknown, fallback: number): number => {
  const n = Array.isArray(v) ? Number(v[0]) : Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Every printable object in bed coordinates as one mesh, as typed arrays. */
function plateArrays(objects: readonly PlateEntry[]): { positions: Float32Array; indices: Uint32Array } {
  const baked = objects.flatMap((o) => o.parts.map((part) => bake(part, o.transform)))
  const positions = new Float32Array(baked.reduce((n, w) => n + w.positions.length, 0))
  const indices = new Uint32Array(baked.reduce((n, w) => n + w.indices.length, 0))
  let p = 0
  let i = 0
  for (const w of baked) {
    const base = p / 3
    positions.set(w.positions, p)
    for (let k = 0; k < w.indices.length; k++) indices[i + k] = base + w.indices[k]!
    p += w.positions.length
    i += w.indices.length
  }
  return { positions, indices }
}

/** Every printable object in bed coordinates as one mesh. */
export function plateMesh(objects: readonly PlateEntry[]): GeomMesh {
  const { positions, indices } = plateArrays(objects)
  return { positions: Array.from(positions), indices: Array.from(indices) }
}

/**
 * What a plan reads: the plate's meshes (each part by identity, held weakly so the comparison keeps no deleted
 * object's mesh alive), where each object stands, and the planner's settings. A part whose mesh changes is a new part.
 */
interface PlanKey {
  parts: WeakRef<object>[]
  placed: string
  settings: string
}

function keyOf(objects: readonly PlateEntry[], settings: unknown): PlanKey {
  return {
    parts: objects.flatMap((o) => o.parts.map((p) => new WeakRef(p))),
    placed: JSON.stringify(objects.map((o) => [o.parts.length, o.transform])),
    settings: JSON.stringify(settings),
  }
}

function sameKey(a: PlanKey, b: PlanKey): boolean {
  if (a.settings !== b.settings || a.placed !== b.placed || a.parts.length !== b.parts.length) return false
  return a.parts.every((r, i) => {
    const part = r.deref()
    return part !== undefined && part === b.parts[i]!.deref()
  })
}

/**
 * A slice canceled by an edit is usually followed at once by the next one, which takes the running plan over when
 * nothing the plan reads changed; a plan nobody comes back for within this long stops (ms).
 */
export const PLAN_GRACE_MS = 1000

interface Run {
  key: PlanKey
  tops: Promise<number[] | null>
  end: () => void
  waiting: number
  idle: ReturnType<typeof setTimeout> | null
}

/** The last plan that finished, and the one running now. */
let last: { key: PlanKey; tops: number[] | null } | null = null
let running: Run | null = null

/** Stops the running plan and forgets the last one, for the tests. */
export function forgetLayerPlans(): void {
  running?.end()
  running = null
  last = null
}

type PlanSettings = { nozzleMm: number; mode: 'quality' | 'strength'; options: Record<string, number> }

function start(objects: readonly PlateEntry[], settings: PlanSettings, key: PlanKey): Run {
  // The app's own worker takes the mesh as typed arrays and hands it to the engine without JSON (engine-call.ts).
  let job: { answer: Promise<{ layerTopsMm?: number[] }>; end: () => void }
  if (usesWorker()) {
    const mesh = plateArrays(objects)
    job = soloCall('layers.plan', { mesh, ...settings }, [mesh.positions.buffer, mesh.indices.buffer])
  } else {
    const ctl = new AbortController()
    job = { answer: geom().call('layers.plan', { mesh: plateMesh(objects), ...settings }, ctl.signal), end: () => ctl.abort() }
  }
  const tops = job.answer.then((r) => (r.layerTopsMm && r.layerTopsMm.length > 1 ? r.layerTopsMm : null))
  const run: Run = { key, tops, end: job.end, waiting: 0, idle: null }
  tops.then(
    (t) => {
      if (running !== run) return
      running = null
      last = { key, tops: t }
    },
    () => {
      if (running === run) running = null
    },
  )
  return run
}

/** The run's answer for one slice. That slice's abort lets go of the run, which stops when nobody else waits on it. */
function waitFor(run: Run, signal: AbortSignal | undefined): Promise<number[] | null> {
  if (run.idle) clearTimeout(run.idle)
  run.idle = null
  run.waiting++
  if (!signal) return run.tops
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException('Canceled', 'AbortError'))
      if (--run.waiting > 0) return
      run.idle = setTimeout(() => {
        if (run.waiting > 0) return
        run.end()
        if (running === run) running = null
      }, PLAN_GRACE_MS)
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    run.tops.then(
      (t) => {
        signal.removeEventListener('abort', onAbort)
        resolve(t)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

/**
 * The layer tops for the plate, first layer first, or null when the plan is not wanted or not possible. The last plan
 * answers again while the plate's meshes, their placement and the planner's settings are the ones it planned; a plan
 * for other inputs stops the one running.
 */
export async function planSmartLayers(objects: readonly PlateEntry[], config: Record<string, unknown>, mode: 'quality' | 'strength', signal?: AbortSignal): Promise<number[] | null> {
  if (objects.length === 0) return null
  const nozzleMm = num(config['nozzle_diameter'], 0.4)
  const settings: PlanSettings = {
    nozzleMm,
    mode,
    options: {
      minHeightMm: num(config['smart_layer_min_height'], 0.15),
      maxHeightMm: num(config['smart_layer_max_height'], nozzleMm * 0.75),
      firstLayerMm: num(config['initial_layer_print_height'], 0.2),
    },
  }
  const key = keyOf(objects, settings)
  if (last && sameKey(last.key, key)) return last.tops
  if (!running || !sameKey(running.key, key)) {
    running?.end()
    running = start(objects, settings, key)
  }
  return waitFor(running, signal)
}
