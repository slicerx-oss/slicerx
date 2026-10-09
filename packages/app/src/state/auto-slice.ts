// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Background slicing. When Auto slice is on, any edit that changes the print starts a new slice after a short pause. A slice
// still running for an older edit is canceled the moment the newer edit lands, and a finished slice is marked stale at once, so
// the numbers and the preview never pass for the current plate.
import type { Host } from '@slicerx/contracts'
import { cancelSlice, slicePlate } from './actions'
import { appStore, type AppState } from './store'

export const AUTO_SLICE_DELAY_MS = 900

/** Everything a slice reads. A change to any of these changes the print. */
export const INPUTS = ['plate', 'plates', 'activePlate', 'overrides', 'easy', 'objectSettings', 'slotSetup', 'printerSlots', 'flush', 'tower', 'layerMarks', 'calibration', 'userPresets', 'printerId', 'printerNozzles', 'printerExtruders', 'bed', 'profile', 'resume'] as const satisfies readonly (keyof AppState)[]

const changed = (a: AppState, b: AppState): boolean => INPUTS.some((k) => a[k] !== b[k])

/** Starts watching the store. Returns the stop function. */
export function startAutoSlice(host: Host, delayMs = AUTO_SLICE_DELAY_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const run = (): void => {
    timer = null
    const s = appStore.getState()
    // A step open for editing rolls the part back; the slice waits for the edit to end.
    if (!s.autoSlice || s.plate.length === 0 || s.plateLoading || s.historyEdit) return
    // A plate switched back to with its slice still current (workspaces/preview/plate-slices.ts) needs none.
    if (s.slice.status === 'done' && !s.slice.stale) return
    void slicePlate(host, { auto: true })
  }
  const unsubscribe = appStore.subscribe((s, prev) => {
    if (!s.autoSlice) return clear()
    // Turning it on slices what is there now.
    const turnedOn = !prev.autoSlice
    if (!turnedOn && !changed(s, prev) && !(prev.plateLoading && !s.plateLoading)) return
    if (s.slice.status === 'running') cancelSlice({ quiet: true })
    if (s.slice.status === 'done' && !s.slice.stale) appStore.setState({ slice: { ...s.slice, stale: true } })
    clear()
    timer = setTimeout(run, delayMs)
  })
  return () => {
    clear()
    unsubscribe()
  }
}
