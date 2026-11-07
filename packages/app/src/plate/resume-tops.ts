// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The layer tops a resume plans with: the failed job's own layers. The app has them while its slice is current or
// once a plan stored them for this plate as it is; otherwise (a reopened project, a resume from the printer list) the
// engine works them out from the plate as the job sliced it, so the plan never counts in layers of its own making.
import type { Host } from '@slicerx/contracts'
import { INPUTS } from '../state/slice-inputs'
import { fullPlate, get, markStale, set, type AppState, type PlateEntry } from '../state/store'

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
 * The slice inputs (state/slice-inputs.ts INPUTS) the key leaves out, and why. Every other input is in it, through
 * `keyOf` below. A new slice input is in the key unless it is listed here.
 */
export const KEY_LEAVES_OUT: Readonly<Partial<Record<(typeof INPUTS)[number], string>>> = {
  layerMarks: 'pauses, color changes and G-code at a height do not move layers',
  resume: 'the plan itself, which the key is checked against',
  plates: "only the shown plate's own settings move its layers; they are in the key",
  plate: "taken as the slice sees it (a history step open for editing slices the whole part), each object's layer inputs only",
  calibration: "only the shown plate's calibration moves its layers; it is in the key",
}
const KEY_INPUTS = INPUTS.filter((k) => !(k in KEY_LEAVES_OUT))

/**
 * The fields of an object (PlateEntry) the key leaves out, and why: none of them moves layers. Every other field is in
 * the key, so a new field counts until it is named here.
 */
export const OBJECT_LEAVES_OUT = {
  name: 'what the object is called',
  colors: 'the colors the object shows in the view',
  thumb: 'its picture in lists',
  instanceOf: 'which object it copies; its mesh hash and placement are in the key',
  splitOf: 'which model it was split from; its own mesh is in the key',
  locked: 'whether it can be moved, not where it is',
  source: 'where the model came from, for the file',
  dimensions: 'measurements drawn on it',
  history: 'its modeling history; the mesh it made is in the key',
} as const satisfies Partial<Record<keyof PlateEntry, string>>

/** What of an object moves layers: every field but OBJECT_LEAVES_OUT, the mesh by its hash and parts by name and filament. */
function objectKey(e: PlateEntry): unknown[] {
  const rec = e as unknown as Record<string, unknown>
  return Object.keys(rec)
    .filter((k) => !(k in OBJECT_LEAVES_OUT) && rec[k] !== undefined && !(k === 'printable' && rec[k] === true))
    .sort()
    .map((k) => [k, k === 'handle' ? e.handle.hash : k === 'parts' ? e.parts.map((p) => [p.name, p.slot]) : rec[k]])
}

/**
 * The tuned filament presets a slice reads (tunedValues, measuredHoleClearance) by what they set, not by name or save
 * time. They stay in the store's order: tunedValues applies them in it, so with two for one spool the later wins. A
 * result keeps its time, since the newest measurement of a spool is the one used.
 */
function tunedPresets(s: AppState): unknown[] {
  return s.userPresets.filter((p) => p.kind === 'filament' && p.tuned?.key).map((p) => [p.id, p.values, p.tuned])
}

/** An input as the key reads it, narrowed to what moves the shown plate's layers. */
function keyOf(k: (typeof KEY_INPUTS)[number], s: AppState, ids: ReadonlySet<string>): unknown {
  // The printer's slots by filament and color, not what is left on a spool or its tag.
  if (k === 'printerSlots') return s.printerSlots.map((slot) => [slot.id, slot.material ?? null, slot.color ?? null])
  if (k === 'userPresets') return tunedPresets(s)
  // Object settings of this plate's objects only.
  if (k === 'objectSettings') return Object.entries(s.objectSettings).filter(([id]) => ids.has(id)).sort(([x], [y]) => (x < y ? -1 : 1))
  // The nozzles and extruders of the printer the slice uses only.
  const printer = s.printerModel?.id
  if (k === 'printerNozzles') return printer ? (s.printerNozzles[printer] ?? null) : null
  if (k === 'printerExtruders') return printer ? (s.printerExtruders[printer] ?? null) : null
  return s[k] ?? null
}

/** State outside INPUTS that picks a slot's filament preset, and so its tuned values (shrinkage moves layers). */
export const KEY_SLOT_MATCH = ['slotMatch', 'fileSlotTypes', 'fileSlotVendors', 'printerModel'] as const satisfies readonly (keyof AppState)[]

/** JSON with mesh arrays as their lengths (the handle hash names their content) and the shipped G-code left out. */
const lean = (key: string, v: unknown): unknown => (ArrayBuffer.isView(v) ? `#${(v as { length?: number }).length ?? 0}` : key === 'shippedGcode' ? undefined : v)

let last: { refs: unknown[]; key: string } | null = null

/**
 * What the shown plate's layers come from, as one key: the slice inputs (state/slice-inputs.ts INPUTS) that move
 * layers, but not the ones KEY_LEAVES_OUT names: each object's layer inputs as the slice sees the plate, this plate's
 * own settings and calibration, the profile and its layer, the Easy choices, overrides, this plate's object settings,
 * filament slots and what matches them to presets, the printer's slots by filament, flush, the prime tower, tuned
 * filament presets, the slice printer's nozzles and extruders and the bed. A spool reload (new grams left or a new tag), a rename, a lock or a thumbnail leaves it as it was. Equal keys
 * mean a slice would plan the same layers. The last key is kept while none of these change.
 */
export function sliceInputsKey(s: AppState): string {
  const meta = s.plates.find((p) => p.id === s.activePlate)
  const refs: unknown[] = [s.plate, s.historyEdit, s.activePlate, meta?.settings, s.calibration[s.activePlate], ...KEY_INPUTS.map((k) => s[k]), ...KEY_SLOT_MATCH.map((k) => s[k])]
  if (last && last.refs.length === refs.length && last.refs.every((r, i) => r === refs[i])) return last.key
  const entries = fullPlate(s)
  const ids = new Set(entries.map((e) => e.id))
  const objects = entries.map(objectKey)
  const slots = KEY_SLOT_MATCH.map((k) => (k === 'printerModel' ? (s.printerModel?.id ?? null) : s[k]))
  const key = hash(JSON.stringify([s.activePlate, objects, meta?.settings ?? null, s.calibration[s.activePlate] ?? null, KEY_INPUTS.map((k) => keyOf(k, s, ids)), slots], lean))
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
    // Layers for the plate as it was when the run began: an edit during the run (a refused project setting dropped,
    // say) leaves them for no one.
    return signal.aborted || get().activePlate !== plate || sliceInputsKey(get()) !== inputs ? null : { plate, inputs, tops }
  } catch (e) {
    if (signal.aborted || get().activePlate !== plate) return null
    throw e
  }
}

/**
 * Why the plate does not slice, and Print and Export wait, while a resume plan is kept for the shown plate that no longer
 * matches it (activeResume): a slice of the whole plate would print into the part still on the bed.
 */
export const RESUME_VOID = 'The resume plan for this plate no longer matches it, so the plate does not slice, print or export. Plan it again, or choose Print everything again.'

/** RESUME_VOID while a resume plan is kept for the shown plate that does not hold for it as it is; else null. A plan for another plate holds nothing here. */
export function resumeVoid(s: AppState): string | null {
  return s.resume && s.resume.plate === s.activePlate && !activeResume(s) ? RESUME_VOID : null
}

/** The plate a kept resume plan was made for, as the person counts plates (1 based); null with no plan. */
function resumePlate(s: AppState): number | null {
  if (!s.resume) return null
  const i = s.plates.findIndex((p) => p.id === s.resume?.plate)
  return i >= 0 ? i + 1 : null
}

/** The plate a kept resume plan was made for (1 based) while another plate is shown: that plate prints freely. */
export function resumeElsewhere(s: AppState): number | null {
  return s.resume && s.resume.plate !== s.activePlate ? resumePlate(s) : null
}

/**
 * Why every plate does not slice into one file while a resume plan is kept: one plate of it would print only the rest
 * of a part. Null with no plan.
 */
export function exportAllBlock(s: AppState): string | null {
  if (!s.resume) return null
  const n = resumePlate(s)
  return `A resume plan is kept${n ? ` for plate ${n}` : ''}. Print that plate on its own, or choose Print everything again first.`
}

/** Print everything again: drops the resume plan, so the next slice, Print and Export are of the whole plate. */
export function printEverythingAgain(): void {
  set({ resume: null })
  markStale()
}
