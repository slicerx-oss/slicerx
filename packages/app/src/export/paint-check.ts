// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint a project opens with, and paint a save warns about. A text that does not read (it runs out, or is not
// upper-case hex) opens unpainted, and so does color paint on a filament the project does not have or past 32: the
// slicer would not know what to print there. Codes past a whole tree are ignored and counted. Each open says so once.
import { decodeTree, encodeTree, paintTextLeftOver, type PaintNode } from '@slicerx/viewport'
import { paintStates } from './listing-colors'

/** The highest filament paint names. */
const PAINT_MAX = 32

/** One part's paint by layer, texts by triangle, as projects and plates keep it. */
export type PartPaint = Partial<Record<'color' | 'seam' | 'support' | 'fuzzy', Record<number, string>>>

/** The tree with leaves past `limit` unpainted. */
function capped(n: PaintNode, limit: number): PaintNode {
  if ('state' in n) return n.state > limit ? { state: 0 } : n
  return { ...n, kids: n.kids.map((k) => capped(k, limit)) }
}

/**
 * Takes out of `paint` what the project cannot show: texts that do not read, and color paint past `filaments` (the
 * filaments the open project has; 0 for up to 32). Returns the one note to show, or null when nothing was taken out or
 * ignored.
 */
export function checkOpenedPaint(paint: Iterable<Record<number, PartPaint>>, filaments: number): string | null {
  const limit = filaments > 0 ? Math.min(filaments, PAINT_MAX) : PAINT_MAX
  let over = false
  let unread = false
  let extra = 0
  for (const parts of paint) {
    for (const [part, layers] of Object.entries(parts)) {
      for (const [layer, texts] of Object.entries(layers) as [keyof PartPaint, Record<number, string>][]) {
        for (const [tri, text] of Object.entries(texts)) {
          const tree = decodeTree(text)
          if (!tree) {
            unread = true
            delete texts[Number(tri)]
            continue
          }
          if (paintTextLeftOver(text) > 0) extra++
          if (layer !== 'color' || Math.max(0, ...paintStates(text)) <= limit) continue
          over = true
          const kept = encodeTree(capped(tree, limit))
          if (kept) texts[Number(tri)] = kept
          else delete texts[Number(tri)]
        }
        if (!Object.keys(texts).length) delete layers[layer]
      }
      if (!Object.keys(layers).length) delete parts[Number(part)]
    }
  }
  const notes: string[] = []
  if (over) notes.push(limit < PAINT_MAX ? `Paint on filament ${limit + 1} and up opens unpainted: this project has ${limit} ${limit === 1 ? 'filament' : 'filaments'}.` : `Paint on filaments above ${PAINT_MAX} opens unpainted.`)
  if (unread) notes.push('Some paint in the file could not be read and opens unpainted.')
  if (extra) notes.push(`${extra} painted ${extra === 1 ? 'triangle has' : 'triangles have'} codes past their paint, which are ignored.`)
  return notes.length ? notes.join(' ') : null
}

/** What a save says when color paint is on filament 17 or higher, which one slicer can't show; null otherwise. */
export function savedPaintNote(objects: Iterable<{ paint?: Record<number, PartPaint> | undefined }>): string | null {
  for (const o of objects) {
    for (const layers of Object.values(o.paint ?? {})) {
      for (const text of Object.values(layers.color ?? {})) if (paintStates(text).some((s) => s > 16)) return "OrcaSlicer can't show paint on filaments above 16."
    }
  }
  return null
}
