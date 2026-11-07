// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The layer tops a resume plans with: the failed job's own layers. The app has them while its slice is current or
// once a plan stored them for this plate as it is; otherwise (a reopened project, a resume from the printer list) the
// engine works them out from the plate as the job sliced it, so the plan never counts in layers of its own making.
import type { Host } from '@slicerx/contracts'
import { fullPlate, get, type AppState } from '../state/store'

/** The store as a slice of the shown plate reads it: a history step open for editing slices the whole part. */
export function sliceState(s: AppState): AppState {
  return s.historyEdit ? { ...s, plate: fullPlate(s) } : s
}

/** A short hash of `text` (FNV-1a, 32 bit, hex). */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * What the shown plate's layers come from, as one key: the plate, its objects (mesh, placement, filaments, paint,
 * volumes, settings), its own settings and layer heights, the profile, the Easy choices, overrides and filament slots.
 * `s` is the store as the slice reads it (sliceState). Equal keys mean a slice would plan the same layers.
 */
export function sliceInputsKey(s: AppState): string {
  const meta = s.plates.find((p) => p.id === s.activePlate)
  const objects = s.plate.map((e) => [e.id, e.handle.hash, e.transform, e.printable ?? true, e.slotOverrides ?? null, e.paint ?? null, e.volumes ?? null, e.partSettings ?? null, s.objectSettings[e.id] ?? null])
  return hash(JSON.stringify([s.activePlate, objects, meta?.settings ?? null, s.calibration[s.activePlate] ?? null, s.profile?.printerId ?? null, s.easy, s.overrides, s.slotSetup]))
}

/**
 * The layers a stored resume plan counted in, while they still hold: planned on this plate with these slice inputs.
 * A plan stored without them (before they were recorded) keeps its tops. `s` is the store as the slice reads it.
 */
export function storedResumeTops(s: AppState): number[] | undefined {
  const r = s.resume
  if (!r?.layerTopsMm?.length) return undefined
  if (r.plate !== undefined && r.plate !== s.activePlate) return undefined
  if (r.inputs !== undefined && r.inputs !== sliceInputsKey(s)) return undefined
  return r.layerTopsMm
}

/**
 * The failed job's layers: a resume plan's stored tops while they hold, else the last slice's layers while it is
 * current. A stale slice (the plate or its settings changed since) is not the plate a resume slices, so it gives none.
 */
export function jobLayerTops(s: AppState): number[] | undefined {
  const stored = storedResumeTops(sliceState(s))
  if (stored) return stored
  if (s.slice.status !== 'done' || s.slice.stale) return undefined
  const z = (s.slice.result as { layerZ?: ArrayLike<number> }).layerZ
  return z && z.length ? Array.from(z) : undefined
}

/** The layers a resume of the shown plate plans with, and the plate and slice inputs they are for. */
export interface ResumeLayers {
  plate: string
  inputs: string
  tops: number[]
}

/**
 * The job's layers for the shown plate: jobLayerTops when the app has them, else the engine's (plateLayerZ, on this
 * device). Null when `signal` aborts or the shown plate changes before they are ready, so a closed dialog or another
 * plate never gets them. Engine errors reach the caller in the words a slice uses.
 */
export async function resumeLayers(host: Host, signal: AbortSignal): Promise<ResumeLayers | null> {
  const plate = get().activePlate
  const inputs = sliceInputsKey(sliceState(get()))
  const job = jobLayerTops(get())
  if (job) return { plate, inputs, tops: job }
  const { plateLayerZ } = await import('../state/slice-plate')
  try {
    const tops = await plateLayerZ(host, signal)
    return signal.aborted || get().activePlate !== plate ? null : { plate, inputs: sliceInputsKey(sliceState(get())), tops }
  } catch (e) {
    if (signal.aborted || get().activePlate !== plate) return null
    throw e
  }
}
