// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Finished sketches stay drawn on their planes in Model, the way Fusion shows a sketch after Finish sketch, where each
// stands now (cad/sketch-place.ts): with the design it was drawn for, or the body of the first feature on it. A sketch
// a live feature was made from hides, as Fusion hides a consumed sketch; rolled back sketches hide too. While the
// sketch tool is open, the one sketch it draws is the tool's.
import type { SketchItem, Timeline } from '@slicerx/cad-history'
import type { SketchScene } from '@slicerx/viewport'
import { useEffect } from 'react'
import { entityPaths, fromLoops, profileRings } from '../../cad/sketch-model'
import { frameShown } from '../../cad/sketch-place'
import { cameraBus } from '../../plate/tools'
import { useApp } from '../../state/store'

/** The sketches to draw: live, and not yet made into a live feature. */
export function shownSketches(t: Timeline): SketchItem[] {
  const live = t.items.slice(0, t.marker)
  const used = new Set(live.flatMap((i) => (i.kind === 'feature' && i.sketch !== undefined ? [i.sketch] : [])))
  return live.filter((i): i is SketchItem => i.kind === 'sketch' && !used.has(i.id))
}

/** A finished sketch as the view draws it: its curves on its plane where it stands now. Null for one sketch mode cannot draw. */
export function sketchScene(k: SketchItem): SketchScene | null {
  const entities = fromLoops(k.loops)
  if (!entities) return null
  const paths = entities.flatMap((e) => entityPaths(e).map((p) => ({ points: p.points, ...(p.closed ? { closed: true } : {}), ...(e.construction ? { tone: 'construction' as const } : {}) })))
  return { frame: frameShown(k), paths, handles: [], profiles: profileRings(entities) }
}

/** Keeps the view's finished sketches current while Model shows, and where they stand as the bodies they move with move. */
export function useFinishedSketches(): void {
  const t = useApp((s) => s.timeline)
  const plate = useApp((s) => s.plate)
  const sketching = useApp((s) => s.objectTool === 'sketch')
  useEffect(() => {
    const view = cameraBus()?.cad
    if (!view) return
    view.setFinishedSketches(sketching ? [] : shownSketches(t).map(sketchScene).filter((s): s is SketchScene => s !== null))
  }, [t, plate, sketching])
  useEffect(() => () => cameraBus()?.cad?.setFinishedSketches([]), [])
}
