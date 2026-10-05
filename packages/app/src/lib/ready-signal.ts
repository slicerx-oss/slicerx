// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A readiness mark on the page, so a script (the browser tests, a screenshot job) waits for the app instead of for
// a fixed time. `data-sx-ready` on the root element is "engine" once the app is up with its slicer pool loaded (the
// host exists before the first render), "plate" once the first plate has finished loading, and "viewport" once the
// 3D view is up as well. It never goes back. `data-sx-busy` is "arrange" while an arrange runs, so a script waits for
// the result before it acts on the plate again; it is removed when the work is done.
import { appStore } from '../state/store'

export type ReadyLevel = 'engine' | 'plate' | 'viewport'

type State = ReturnType<typeof appStore.getState>

const ORDER: ReadyLevel[] = ['engine', 'plate', 'viewport']

export function startReadySignal(root: HTMLElement = document.documentElement): () => void {
  const busy = (s: State): void => {
    if (s.arranging) root.dataset['sxBusy'] = 'arrange'
    else delete root.dataset['sxBusy']
  }
  busy(appStore.getState())
  const offBusy = appStore.subscribe(busy)
  return chain(startReady(root), offBusy)
}

function chain(...offs: (() => void)[]): () => void {
  return () => {
    for (const off of offs) off()
  }
}

function startReady(root: HTMLElement): () => void {
  let plated = false
  // Plate and viewport may come up in either order; the mark is "viewport" once both have, and only rises.
  const mark = (s: State): boolean => {
    if (!s.plateLoading && s.plate.length > 0) plated = true
    const level: ReadyLevel = !plated ? 'engine' : s.viewportBackend ? 'viewport' : 'plate'
    const now = root.dataset['sxReady'] as ReadyLevel | undefined
    if (!now || ORDER.indexOf(level) > ORDER.indexOf(now)) root.dataset['sxReady'] = level
    return level === 'viewport'
  }
  if (mark(appStore.getState())) return () => undefined
  const off = appStore.subscribe((s) => {
    if (mark(s)) off()
  })
  return off
}
