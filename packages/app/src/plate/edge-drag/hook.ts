// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The view's hook for plate edge drag, and all of it that loads with the 3D view: a few lines that let a move go past
// the bed and pass it on. The gesture code and its overlay (session.ts) load on the first move that starts one, so a
// session that never drags a part never loads them, and nothing of it runs or listens while no part is moving.
import type { EdgeDragHook, EdgeDragInfo } from '@slicerx/viewport'
import { commitMarginMm, mmPerPxAt, reachPastLineMm } from './reach'
import type { EdgeSession, EdgeView } from './session'

export interface EdgeHookOptions {
  view: EdgeView
  /** The element the view's canvas sits in; the overlay goes over the canvas in it while a part moves. */
  stage: HTMLElement
  /** The bed's size, mm. */
  bed(): { widthMm: number; depthMm: number }
  /** Whether these objects may leave the plate this way (not the prime tower, not while a history step is open). */
  accepts(ids: readonly string[]): boolean
}

let loading: Promise<typeof import('./session')> | null = null
/** Loads the gesture code once. */
export const loadEdgeSession = (): Promise<typeof import('./session')> => (loading ??= import('./session'))

/** The view's edge hook. Before the gesture code arrives (a very quick first drag) a release off the bed goes back. */
export function edgeDragHook(o: EdgeHookOptions): EdgeDragHook {
  let session: EdgeSession | null = null
  let live = 0
  let latest: EdgeDragInfo | null = null
  return {
    start(e) {
      if (!o.accepts(e.ids)) return false
      const run = ++live
      latest = e
      void loadEdgeSession().then(
        (m) => {
          if (run !== live || session || !latest) return
          session = m.startEdgeSession({ view: o.view, stage: o.stage, bed: o.bed(), first: latest })
        },
        () => undefined,
      )
      return true
    },
    reachMm() {
      if (session) return session.reachMm()
      const bed = o.bed()
      const k = mmPerPxAt((p) => o.view.screenOf(p), [bed.widthMm / 2, bed.depthMm / 2], [1, 0])
      return commitMarginMm(k) + reachPastLineMm(k)
    },
    move(e) {
      latest = e
      session?.move(e)
    },
    end(e) {
      live++
      latest = null
      const s = session
      session = null
      return s ? s.end(e) : 'back'
    },
    cancel() {
      live++
      latest = null
      const s = session
      session = null
      s?.cancel()
    },
  }
}
