// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keeps kept dimensions current and drawn. Loaded by the viewport host the first time an object has a
// dimension or the Show dimensions toggle goes on. After every plate change that touches them (a mesh
// edit, a move, an undo) it runs dimension.evaluate once, a moment later, and hands the view lines and
// labels: those of the selected object, or all of them with the toggle on. Nothing runs per frame.
import { createStore, useStore } from 'zustand'
import { evaluateDimensions, type EvaluatedDimension } from '../geom/cad'
import type { CadView } from '../plate/tools'
import { appStore, type AppState } from '../state/store'
import { allDimensions, markFor, objectsFor } from './dimensions'

/** The last evaluation of each dimension, by id. */
export const dimStore = createStore<{ results: Record<string, EvaluatedDimension> }>()(() => ({ results: {} }))

export function useDimensionResults(): Record<string, EvaluatedDimension> {
  return useStore(dimStore, (s) => s.results)
}

/** What a change must touch for the dimensions to be evaluated again. */
function inputs(s: AppState): unknown[] {
  const dims = allDimensions(s.plate)
  const ids = new Set(dims.flatMap(({ d }) => [d.a.object, ...(d.b ? [d.b.object] : [])]))
  return [...dims.map((x) => x.d), ...s.plate.filter((e) => ids.has(e.id)).flatMap((e) => [e.parts, e.transform])]
}

const sameList = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i])

let running: (() => void) | null = null

/** Starts the bridge for a view, ending one already running. Returns the stop function. */
export function startDimensions(view: CadView): () => void {
  running?.()
  let last: unknown[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let ac: AbortController | null = null
  let stopped = false

  const draw = () => {
    const s = appStore.getState()
    const { results } = dimStore.getState()
    const selected = new Set(s.selectedIds.length ? s.selectedIds : s.selection ? [s.selection] : [])
    const marks = allDimensions(s.plate)
      .filter(({ owner, d }) => s.showDimensions || selected.has(owner) || selected.has(d.b?.object ?? ''))
      .flatMap(({ d }) => {
        const r = results[d.id]
        const m = r ? markFor(d, r, s.plate) : null
        return m ? [m] : []
      })
    view.setDimensions(marks)
  }

  const evaluate = () => {
    timer = null
    ac?.abort()
    const s = appStore.getState()
    const dims = allDimensions(s.plate).map((x) => x.d)
    if (!dims.length) {
      dimStore.setState({ results: {} })
      return draw()
    }
    const mine = (ac = new AbortController())
    evaluateDimensions(dims, objectsFor(s.plate, dims), [], mine.signal).then(
      (ev) => {
        if (mine.signal.aborted || stopped) return
        dimStore.setState({ results: Object.fromEntries(ev.map((r) => [r.id, r])) })
        draw()
      },
      () => undefined,
    )
  }

  const onChange = (s: AppState, prev: AppState) => {
    const now = inputs(s)
    if (!sameList(now, last)) {
      last = now
      if (timer) clearTimeout(timer)
      timer = setTimeout(evaluate, 60)
    } else if (s.selection !== prev.selection || s.selectedIds !== prev.selectedIds || s.showDimensions !== prev.showDimensions) draw()
  }
  const off = appStore.subscribe(onChange)
  last = inputs(appStore.getState())
  evaluate()
  const stop = () => {
    stopped = true
    off()
    ac?.abort()
    if (timer) clearTimeout(timer)
    view.setDimensions([])
    if (running === stop) running = null
  }
  running = stop
  return stop
}
