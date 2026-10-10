// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Background slicing. When Auto slice is on, any edit that changes the print starts a new slice after a short pause; set
// to Auto (by size, the default) a plate whose slice is expected to be big waits for Slice instead (auto-slice-mode.ts). A slice
// still running for an older edit is canceled the moment the newer edit lands, and a finished slice is marked stale at once, so
// the numbers and the preview never pass for the current plate. A drag that edits on every move (a scrub, a slider) slices
// once, on release.
import type { Host } from '@slicerx/contracts'
import { cancelSlice, slicePlate } from './actions'
import { fitSettledFor, onFitSettled } from '../plate/fit-state'
import { isBigSlice, sliceTimingOf } from './slice-estimate'
import { inputsChanged as changed } from './slice-inputs'
import { appStore } from './store'

export { INPUTS } from './slice-inputs'

/**
 * The pause after an edit before the slice starts. Edits arrive whole (a typed value on Enter, a click, a drag on
 * release), so this only gathers ones that land together, such as a tile that sets several values.
 */
export const AUTO_SLICE_DELAY_MS = 150

/**
 * The longest a big slice waits for the plate's fit check (ms): a check that never reports (its watch not mounted, say)
 * does not hold the slice back for good.
 */
export const FIT_WAIT_MS = 15_000

/** Starts watching the store. Returns the stop function. */
export function startAutoSlice(host: Host, delayMs = AUTO_SLICE_DELAY_MS, fitWaitMs = FIT_WAIT_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let waiting: (() => void) | null = null
  const clear = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    waiting?.()
    waiting = null
  }
  /** `force`: the wait for the fit check ran out, so a big slice goes anyway. */
  const run = (force = false): void => {
    timer = null
    const s = appStore.getState()
    if (s.plate.length === 0 && s.sliceHeld) appStore.setState({ sliceHeld: false })
    // A step open for editing rolls the part back; the slice waits for the edit to end.
    if (!s.autoSlice || s.plate.length === 0 || (s.plateLoading && !s.sliceDuringOpen) || s.historyEdit) return
    // A plate switched back to with its slice still current (workspaces/preview/plate-slices.ts) needs none.
    if (s.slice.status === 'done' && !s.slice.stale) return
    // Auto by size: a big slice waits for Slice, and the footer says so.
    const big = isBigSlice(s.plate, sliceTimingOf(s.activePlate))
    if (s.autoSliceBySize && big) {
      if (!s.sliceHeld) appStore.setState({ sliceHeld: true })
      return
    }
    if (s.sliceHeld) appStore.setState({ sliceHeld: false })
    // A big slice waits for the plate's fit check, so its copy of the meshes and the fit check's are not alive at once
    // (slice-estimate.ts); a small one goes now.
    if (!force && !s.plateLoading && !fitSettledFor(s.plate) && big) {
      const go = (late: boolean): void => {
        clear()
        timer = setTimeout(() => run(late), 0)
      }
      const off = onFitSettled(() => fitSettledFor(appStore.getState().plate) && go(false))
      const late = setTimeout(() => go(true), fitWaitMs)
      waiting = () => {
        off()
        clearTimeout(late)
      }
      return
    }
    waiting?.()
    waiting = null
    void slicePlate(host, { auto: true })
  }
  const unsubscribe = appStore.subscribe((s, prev) => {
    if (!s.autoSlice) {
      if (s.sliceHeld) appStore.setState({ sliceHeld: false })
      return clear()
    }
    // Turning it on, or from Auto to Always, slices what is there now.
    const turnedOn = !prev.autoSlice || (prev.autoSliceBySize && !s.autoSliceBySize)
    const released = prev.liveEdit && !s.liveEdit
    const loaded = prev.plateLoading && !s.plateLoading
    if (!turnedOn && !released && !changed(s, prev) && !loaded) return
    // An open whose model sliced while it loaded and did not change since: that slice, running or done, is the one.
    if (loaded && prev.sliceDuringOpen && !turnedOn && !released && !changed(s, prev) && (s.slice.status === 'running' || (s.slice.status === 'done' && !s.slice.stale))) return
    if (s.slice.status === 'running') cancelSlice({ quiet: true })
    if (s.slice.status === 'done' && !s.slice.stale) appStore.setState({ slice: { ...s.slice, stale: true } })
    clear()
    // Mid-drag the slice would be thrown away on the next move; the release starts it.
    if (s.liveEdit) return
    timer = setTimeout(() => run(), delayMs)
  })
  return () => {
    clear()
    unsubscribe()
  }
}
