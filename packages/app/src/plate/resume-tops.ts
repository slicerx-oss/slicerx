// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The layer tops a resume plans with: the failed job's own layers. The app has them while its slice is current or
// once a plan stored them for this plate as it is; otherwise (a reopened project, a resume from the printer list) the
// engine works them out from the plate as the job sliced it, so the plan never counts in layers of its own making.
import type { Host } from '@slicerx/contracts'
import { INPUTS } from '../state/slice-inputs'
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

/** The slice inputs (state/slice-inputs.ts) the key reads; layer marks and the resume plan itself do not move layers. */
const KEY_INPUTS = INPUTS.filter((k) => k !== 'layerMarks' && k !== 'resume' && k !== 'plates' && k !== 'plate' && k !== 'calibration')

/** JSON with mesh arrays as their lengths (the handle hash names their content) and the shipped G-code left out. */
const lean = (key: string, v: unknown): unknown => (ArrayBuffer.isView(v) ? `#${(v as { length?: number }).length ?? 0}` : key === 'shippedGcode' ? undefined : v)

let last: { refs: unknown[]; key: string } | null = null

/**
 * What the shown plate's layers come from, as one key: every slice input (state/slice-inputs.ts INPUTS) a slice of
 * this plate reads, but layer marks and the resume plan: the plate's objects as the slice sees them (a history step
 * open for editing slices the whole part), this plate's own settings and calibration, the profile and its layer, the
 * Easy choices, overrides, object settings, filament slots and the printer's, flush, the prime tower, user presets,
 * nozzles, extruders and the bed. Equal keys mean a slice would plan the same layers. The last key is kept while
 * none of these change, so asking often costs nothing.
 */
export function sliceInputsKey(s: AppState): string {
  const meta = s.plates.find((p) => p.id === s.activePlate)
  const refs: unknown[] = [s.plate, s.historyEdit, s.activePlate, meta?.settings, s.calibration[s.activePlate], ...KEY_INPUTS.map((k) => s[k])]
  if (last && last.refs.length === refs.length && last.refs.every((r, i) => r === refs[i])) return last.key
  const objects = fullPlate(s)
  const key = hash(JSON.stringify([s.activePlate, objects, meta?.settings ?? null, s.calibration[s.activePlate] ?? null, KEY_INPUTS.map((k) => s[k] ?? null)], lean))
  last = { refs, key }
  return key
}

/**
 * The resume plan while it still holds: planned on the shown plate with these slice inputs. A plan made for another
 * plate, or before an edit to this one, counts its layers in layers this plate no longer slices, so none of it holds:
 * not the stored tops, not the layer it starts from and not the height it declares. A plan that does not say which
 * plate and inputs it was made for holds for none.
 */
export function activeResume(s: AppState): NonNullable<AppState['resume']> | null {
  const r = s.resume
  if (!r || r.plate !== s.activePlate || r.inputs === undefined || r.inputs !== sliceInputsKey(s)) return null
  return r
}

/** The layers the resume plan that holds (activeResume) counted in. */
export function storedResumeTops(s: AppState): number[] | undefined {
  const tops = activeResume(s)?.layerTopsMm
  return tops?.length ? tops : undefined
}

/** A resume plan for the shown plate as it is now: what Slice the rest stores. */
export function resumeFor(s: AppState, r: Omit<NonNullable<AppState['resume']>, 'plate' | 'inputs'>): NonNullable<AppState['resume']> {
  return { ...r, plate: s.activePlate, inputs: sliceInputsKey(s) }
}

/**
 * The failed job's layers: a resume plan's stored tops while they hold, else the last slice's layers while it is
 * current. A stale slice (the plate or its settings changed since) is not the plate a resume slices, so it gives none.
 */
export function jobLayerTops(s: AppState): number[] | undefined {
  const stored = storedResumeTops(s)
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
  const inputs = sliceInputsKey(get())
  const job = jobLayerTops(get())
  if (job) return { plate, inputs, tops: job }
  const { plateLayerZ } = await import('../state/slice-plate')
  try {
    const tops = await plateLayerZ(host, signal)
    return signal.aborted || get().activePlate !== plate ? null : { plate, inputs, tops }
  } catch (e) {
    if (signal.aborted || get().activePlate !== plate) return null
    throw e
  }
}
