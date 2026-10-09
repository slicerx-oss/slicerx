// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Background slicing. When Auto slice is on, any edit that changes the print starts a new slice after a short pause. A slice
// still running for an older edit is canceled the moment the newer edit lands, and a finished slice is marked stale at once, so
// the numbers and the preview never pass for the current plate. A drag that edits on every move (a scrub, a slider) slices
// once, on release.
import type { Host } from '@slicerx/contracts'
import { cancelSlice, slicePlate } from './actions'
import { inputsChanged as changed } from './slice-inputs'
import { appStore } from './store'

export { INPUTS } from './slice-inputs'

/**
 * The pause after an edit before the slice starts. Edits arrive whole (a typed value on Enter, a click, a drag on
 * release), so this only gathers ones that land together, such as a tile that sets several values.
 */
export const AUTO_SLICE_DELAY_MS = 150

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
    const released = prev.liveEdit && !s.liveEdit
    if (!turnedOn && !released && !changed(s, prev) && !(prev.plateLoading && !s.plateLoading)) return
    if (s.slice.status === 'running') cancelSlice({ quiet: true })
    if (s.slice.status === 'done' && !s.slice.stale) appStore.setState({ slice: { ...s.slice, stale: true } })
    clear()
    // Mid-drag the slice would be thrown away on the next move; the release starts it.
    if (s.liveEdit) return
    timer = setTimeout(run, delayMs)
  })
  return () => {
    clear()
    unsubscribe()
  }
}
