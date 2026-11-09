// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Finished sketches stay drawn on their planes in Model, the way Fusion shows a sketch after Finish sketch, where each
// stands now (cad/sketch-place.ts): with the design it was drawn for, or the body of the first feature on it. A sketch
// a live feature was made from hides, as Fusion hides a consumed sketch; rolled back sketches hide too. While the
// sketch tool is open, the one sketch it draws is the tool's.
// While Loft or Sweep is open the sketches are pickable (cad/sketch-pick.ts), and each picked one shows its mark.
import type { SketchItem, Timeline } from '@slicerx/cad-history'
import { shownSketches } from '../../cad/sketch-gates'
import type { FinishedSketch } from '@slicerx/viewport'
import { useEffect } from 'react'
import { entityPaths, fromLoops, profileRings } from '../../cad/sketch-model'
import { frameShown } from '../../cad/sketch-place'
import { cameraBus } from '../../plate/tools'
import { useSketchPicker } from '../../cad/sketch-pick'
import { usePhoneLayout } from '../../lib/phone-layout'
import { OVERLAY_GAP } from '../../viewport/overlay-insets'
import { useApp } from '../../state/store'

export { shownSketches }

/**
 * How much of the view a phone covers at its top (the selection and transform toolbars and the camera buttons, every
 * floating bar whose middle is in the view's upper half) and at its bottom (the docked tool sheet), in pixels, with a
 * small gap so nothing framed touches them.
 */
export function phoneCover(canvas: DOMRect): { coverTopPx: number; coverBottomPx: number } {
  const mid = (canvas.top + canvas.bottom) / 2
  let top = canvas.top
  for (const el of document.querySelectorAll<HTMLElement>('.sx-overlay')) {
    if (el.offsetParent === null || el.closest('.pane.sheet')) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0 || r.bottom <= canvas.top || r.top >= canvas.bottom || (r.top + r.bottom) / 2 > mid) continue
    top = Math.max(top, r.bottom)
  }
  const sheet = document.querySelector('.pane.sheet.sheet-docked')?.getBoundingClientRect()
  return { coverTopPx: top > canvas.top ? top - canvas.top + OVERLAY_GAP : 0, coverBottomPx: sheet ? Math.max(0, canvas.bottom - sheet.top) + OVERLAY_GAP : 0 }
}

/** How long the phone's tool sheet takes to come up before the view frames above it. */
const SHEET_SETTLE_MS = 350

/** A finished sketch as the view draws it: its curves on its plane where it stands now. Null for one sketch mode cannot draw. */
export function sketchScene(k: SketchItem): FinishedSketch | null {
  const entities = fromLoops(k.loops)
  if (!entities) return null
  const paths = entities.flatMap((e) => entityPaths(e).map((p) => ({ points: p.points, ...(p.closed ? { closed: true } : {}), ...(e.construction ? { tone: 'construction' as const } : {}) })))
  return { frame: frameShown(k), paths, handles: [], profiles: profileRings(entities) }
}

/**
 * The sketches to draw while a tool picks them: the ones shown, each with its id and the mark the tool gives it, and
 * also a picked one a live feature uses (the sources of the loft or sweep being edited), so every pick shows.
 */
export function pickableSketches(t: Timeline, marks: ReadonlyMap<string, string>): SketchItem[] {
  const shown = shownSketches(t)
  const extra = t.items.slice(0, t.marker).filter((i): i is SketchItem => i.kind === 'sketch' && marks.has(i.id) && !shown.includes(i))
  return [...shown, ...extra]
}

/** Keeps the view's finished sketches current while Model shows, and where they stand as the bodies they move with move. */
export function useFinishedSketches(): void {
  const t = useApp((s) => s.timeline)
  const plate = useApp((s) => s.plate)
  const sketching = useApp((s) => s.objectTool === 'sketch')
  const picker = useSketchPicker()
  useEffect(() => {
    const view = cameraBus()?.cad
    if (!view) return
    if (sketching) return view.setFinishedSketches([])
    const list = picker ? pickableSketches(t, picker.marks) : shownSketches(t)
    view.setFinishedSketches(list.flatMap((k): FinishedSketch[] => {
      const s = sketchScene(k)
      if (!s) return []
      const mark = picker?.marks.get(k.id)
      return [{ ...s, ...(picker ? { id: k.id } : {}), ...(mark !== undefined ? { mark } : {}) }]
    }))
  }, [t, plate, sketching, picker])
  useEffect(() => {
    cameraBus()?.cad?.setSketchPicking?.(picker !== null && !sketching)
  }, [picker, sketching])
  // On a phone the tool sheet covers the lower view as Loft or Sweep opens: the sketches to pick are framed above it
  const phone = usePhoneLayout()
  const open = picker !== null && !sketching
  useEffect(() => {
    if (!open || !phone) return
    const t = window.setTimeout(() => {
      const view = cameraBus()?.cad
      const canvas = view?.canvas?.getBoundingClientRect()
      if (!canvas) return
      view?.frameSketches?.(phoneCover(canvas))
    }, SHEET_SETTLE_MS)
    return () => window.clearTimeout(t)
  }, [open, phone])
  useEffect(() => () => {
    cameraBus()?.cad?.setFinishedSketches([])
    cameraBus()?.cad?.setSketchPicking?.(false)
  }, [])
}
