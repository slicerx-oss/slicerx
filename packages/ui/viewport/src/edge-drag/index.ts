// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @slicerx/viewport/edge-drag: drag a part off a bed edge to move it to another plate, as one option.
//
// While a part moves, each bed edge shows a band in the space off the bed with a chevron and a label. The left, top
// and right edges add the part to the host's other plates in plate order, the bottom adds it to a new plate, and past
// three other plates the top opens a short list of the rest. A release moves it once the whole part (or selection) is
// past the edge by 8 mm or 24 screen pixels, whichever is more; a release short of that line, Esc or a lost pointer
// puts it back. The host owns the plates: it lists them, does the move (and its undo), and shows the plate after.
//
// This entry is small: it sets the view's hook. The gesture code and its overlay (session.ts) load on the first part
// drag, and exist only while a part moves.
import type { EdgeDragHook, EdgeDragInfo, Viewport } from '../types'
import type { PlateRef } from './geometry'
import type { EdgeDragLabels } from './labels'
import { commitMarginMm, mmPerPxAt, reachPastLineMm } from './reach'
import type { EdgeSession } from './session'
import type { EdgeDragTheme } from './properties'

export type { PlateRef } from './geometry'
export type { EdgeDragLabels } from './labels'
export type { EdgeDragTheme } from './properties'
export { OVERLAY_GAP, overlayInsets, type PxInsets, type Rect } from './insets'

/** Where the host is asked to move the parts: an existing plate by id, or a new plate it adds after the others. */
export type EdgeDragDestination = { plate: string } | 'new'

/** The calls the gesture makes on the view: all of @slicerx/viewport's Viewport has them. */
export type EdgeDragViewport = Pick<Viewport, 'canvas' | 'setSelection'> & {
  setEdgeDrag?: Viewport['setEdgeDrag']
  screenOf?: Viewport['screenOf']
  cancelDrag?: Viewport['cancelDrag']
  setDragZoom?: Viewport['setDragZoom']
  placeReadout?: Viewport['placeReadout']
  keepCamera?: Viewport['keepCamera']
  showSelection?: Viewport['showSelection']
}

/** What the host supplies, and how the gesture looks and reads. */
export interface EdgeDragOptions {
  /** The host's plates, each with an id, the name its label shows ("Plate 2") and its place in plate order. */
  plates(): readonly PlateRef[]
  /** The id of the plate the view shows now. */
  activePlate(): string
  /**
   * Moves the objects off the shown plate: to another plate, or with 'new' to a new plate the host adds after the
   * others. The host does the move, places the objects on that plate and makes it one undo step. It may return the
   * id of the plate they went to (for 'new', the gesture otherwise finds the plate that was added).
   */
  move(objectIds: readonly string[], dest: EdgeDragDestination): void | string | Promise<void | string>
  /** The host's own bars and panels over the view, in client pixels: the room fit keeps every edge clear of them. Default none. */
  obstacles?(): readonly DOMRect[]
  /**
   * The plate bar or picker the part flies to on a drop, in client pixels. With null (or no function), as on a phone
   * with no plate bar, there is no flight: the plate shows at once, framed as the view was, and a short note says where
   * the part went (`notify`).
   */
  dropTarget?(): DOMRect | null
  /**
   * Says where a drop with no drop target went ("Moved to Plate 4"), as the host's own toast. Without it the overlay
   * shows the note itself for a moment.
   */
  notify?(message: string, plateId: string): void
  /** After a drop: show the plate the objects went to and select them. Without it the view stays on its plate. */
  onSwitch?(plateId: string, objectIds: readonly string[]): void
  /** Whether these objects may leave the plate this way; false keeps the move on the bed. Default true. */
  canMove?(objectIds: readonly string[]): boolean
  /** The element the overlay goes into, over the canvas. Default the canvas's parent, which should be positioned. */
  stage?: HTMLElement
  /** Colors, as the custom properties in EDGE_DRAG_PROPERTIES, set on the overlay over whatever the page sets. */
  theme?: EdgeDragTheme
  /** Any of the strings, in place of the English ones in DEFAULT_EDGE_DRAG_LABELS. */
  labels?: Partial<EdgeDragLabels>
}

export { DEFAULT_EDGE_DRAG_LABELS } from './labels'
export { EDGE_DRAG_PROPERTIES } from './properties'

let loading: Promise<typeof import('./session')> | null = null
/** Loads the gesture code once. Hosts need not call it; the first part drag does. */
export const loadEdgeDrag = (): Promise<typeof import('./session')> => (loading ??= import('./session'))

let mounted = 0
/** How many overlays are up now: 0 whenever no part moves. */
export const overlaysMounted = (): number => mounted
/** @internal the session counts itself in and out. */
export const countOverlay = (d: 1 | -1): void => {
  mounted += d
}

let hinted = false
/** @internal whether the short release hint has shown this session; it shows once. */
export const hintShown = (set?: boolean): boolean => {
  if (set) hinted = true
  return hinted
}
/** Shows the short release hint again on the next short release (for tests and demos). */
export function resetHint(): void {
  hinted = false
}

/**
 * Turns plate edge drag on for a view. Returns the call that turns it off again. Nothing runs, listens or draws until
 * a part moves.
 */
export function enableEdgeDrag(viewport: EdgeDragViewport, options: EdgeDragOptions): () => void {
  if (!viewport.setEdgeDrag || !viewport.screenOf) return () => undefined
  const hook = edgeDragHook(viewport, options)
  viewport.setEdgeDrag(hook)
  return () => viewport.setEdgeDrag?.(null)
}

/** The view's hook. Before the gesture code arrives (a very quick first drag) a release off the bed goes back. */
function edgeDragHook(viewport: EdgeDragViewport, options: EdgeDragOptions): EdgeDragHook {
  let session: EdgeSession | null = null
  let live = 0
  let latest: EdgeDragInfo | null = null
  const screenOf = (p: [number, number, number]) => viewport.screenOf?.(p) ?? null
  return {
    start(e) {
      if (options.canMove && !options.canMove(e.ids)) return false
      const run = ++live
      latest = e
      void loadEdgeDrag().then(
        (m) => {
          if (run !== live || session || !latest) return
          const stage = options.stage ?? viewport.canvas.parentElement
          if (!stage) return
          session = m.startEdgeSession({ viewport, stage, options, first: latest })
        },
        () => undefined,
      )
      return true
    },
    reachMm() {
      if (session) return session.reachMm()
      const bed = latest?.bed ?? { widthMm: 0, depthMm: 0 }
      const k = mmPerPxAt(screenOf, [bed.widthMm / 2, bed.depthMm / 2], [1, 0])
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
