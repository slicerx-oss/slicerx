// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which finished sketches are there to use, and why Loft and Sweep wait for more: light enough for the ribbon, the
// shelf and the command bar, which load before any modeling code.
import type { SketchItem, Timeline } from '@slicerx/cad-history'

export type SolidTool = 'loft' | 'sweep'

/** The sketches to draw: live, and not yet made into a live feature (drawn on, or lofted or swept from). */
export function shownSketches(t: Timeline): SketchItem[] {
  const live = t.items.slice(0, t.marker)
  const used = new Set(live.flatMap((i) => (i.kind === 'feature' ? [...(i.sketch !== undefined ? [i.sketch] : []), ...(i.uses ?? [])] : [])))
  return live.filter((i): i is SketchItem => i.kind === 'sketch' && !used.has(i.id))
}

/** Why a ribbon or menu entry for the tool is off with this many finished sketches showing, or null. */
export function sketchesOff(tool: SolidTool, shown: number): string | null {
  if (tool === 'loft') return shown < 2 ? 'Finish two sketches first.' : null
  return shown < 1 ? 'Finish a sketch first.' : null
}
