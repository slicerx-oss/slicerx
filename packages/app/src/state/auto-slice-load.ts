// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Starts background slicing (auto-slice.ts) once its code has loaded, so that code stays out of the shell's startup
// chunks. A change made while it loads is caught up from the state when the start was asked for (startAutoSlice's
// `since`): an edit in that window slices once, and no edit slices nothing.
import type { Host } from '@slicerx/contracts'
import { appStore } from './store'

type AutoSlice = Pick<typeof import('./auto-slice'), 'startAutoSlice'>

/** Starts watching the store once `load` resolves. Returns the stop function, which also drops a start not made yet. */
export function startAutoSliceLoaded(host: Host, load: () => Promise<AutoSlice> = () => import('./auto-slice')): () => void {
  const since = appStore.getState()
  let stop: (() => void) | undefined
  let gone = false
  void load().then((m) => {
    if (!gone) stop = m.startAutoSlice(host, undefined, undefined, since)
  })
  return () => {
    gone = true
    stop?.()
  }
}
