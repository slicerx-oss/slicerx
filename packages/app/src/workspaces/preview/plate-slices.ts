// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every plate keeps its slice. Leaving a plate puts its slice and preview aside; coming back puts them in Preview
// again, marked stale when anything the slice read has changed since. So switching plates in Preview flips
// between finished slices instead of starting over, the way Bambu Studio's multi-plate preview does.
import { INPUTS } from '../../state/auto-slice'
import { appStore, type AppState, type SliceState } from '../../state/store'

/** Most plates whose slices are kept besides the one in view; the oldest is let go first. */
const KEEP = 6

/** What a plate's slice was made from: the slice inputs, compared by reference, without the plate list itself. */
type Inputs = Partial<Record<(typeof INPUTS)[number] | 'settings', unknown>>

interface Kept {
  slice: Extract<SliceState, { status: 'done' }>
  preview: NonNullable<AppState['preview']>
  layerHi: number
  layerLo: number
  moveCut: number
  inputs: Inputs
}

const kept = new Map<string, Kept>()

function inputsOf(s: AppState): Inputs {
  const out: Inputs = {}
  for (const k of INPUTS) if (k !== 'plates' && k !== 'activePlate') out[k] = s[k]
  out.settings = s.plates.find((p) => p.id === s.activePlate)?.settings
  return out
}

function same(a: Inputs, b: Inputs): boolean {
  return Object.keys(a).every((k) => a[k as keyof Inputs] === b[k as keyof Inputs])
}

/** Whether a plate other than the one in view has a slice kept, and if it is still current with the settings of now. */
export function keptSlice(plateId: string, s: AppState = appStore.getState()): { stale: boolean } | null {
  const k = kept.get(plateId)
  if (!k) return null
  const meta = s.plates.find((p) => p.id === plateId)
  const now = { ...inputsOf(s), plate: meta?.objects, settings: meta?.settings }
  return { stale: k.slice.stale || !same(k.inputs, now) }
}

/** The ids of the slices kept for plates out of view. */
export function keptSliceIds(): string[] {
  return [...kept.values()].map((k) => k.slice.result.id)
}

/** The preview kept for a plate, for its thumbnail. */
export function keptPreview(plateId: string): Kept['preview'] | null {
  return kept.get(plateId)?.preview ?? null
}

/** Starts keeping slices per plate. Returns the stop function. */
export function trackPlateSlices(): () => void {
  return appStore.subscribe((s, prev) => {
    // A new project (or a cleared plate, which is one) starts with no slices kept, not even the one in view as it
    // closed: plate ids repeat across projects.
    if (s.plates !== prev.plates && s.slice.status === 'idle' && s.plate.length === 0 && s.plates.every((p) => p.objects.length === 0)) return kept.clear()
    // Plates that are gone take their slices with them.
    if (s.plates !== prev.plates) for (const id of kept.keys()) if (!s.plates.some((p) => p.id === id)) kept.delete(id)
    if (s.activePlate === prev.activePlate) return
    // A norn comparison belongs to the plate it was made on.
    const norn = { ...s.norn, pick: null, before: null, ghost: false }
    if (prev.slice.status === 'done' && prev.preview) {
      kept.delete(prev.activePlate)
      kept.set(prev.activePlate, { slice: prev.slice, preview: prev.preview, layerHi: prev.layerHi, layerLo: prev.layerLo, moveCut: prev.moveCut, inputs: inputsOf(prev) })
      while (kept.size > KEEP) kept.delete(kept.keys().next().value as string)
    }
    const back = kept.get(s.activePlate)
    if (!back || s.slice.status === 'running') {
      if (s.norn.pick || s.norn.before) appStore.setState({ norn })
      return
    }
    kept.delete(s.activePlate)
    const stale = back.slice.stale || !same(back.inputs, inputsOf(s))
    appStore.setState({
      slice: { ...back.slice, stale },
      preview: back.preview,
      layerHi: back.layerHi,
      layerLo: back.layerLo,
      moveCut: back.moveCut,
      norn,
    })
  })
}

/** Forgets every kept slice (tests, and a new project). */
export function forgetPlateSlices(): void {
  kept.clear()
}
