// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What clicking a slice warning does: jump to its layer, switch to the color scheme that shows it, and
// the one-step fix when there is one.
import type { SliceWarning } from '@slicerx/contracts'
import type { ColorMode } from '../state/store'
import { cameraBus } from '../plate/tools'
import { get, markStale, set, toast } from '../state/store'

export type WarningFixId = 'supports' | 'arrange' | 'repair' | 'settings'

/** The color scheme that explains a warning. Feature type shows overhangs and thin walls; flow shows a volumetric cap. */
export function warningScheme(w: SliceWarning): ColorMode | null {
  if (/volumetric|flow rate|max flow/i.test(w.message)) return 'flow'
  if (w.code === 'floating_region' || w.code === 'long_bridge' || w.code === 'thin_wall') return 'feature'
  return null
}

export function warningFix(w: SliceWarning): { id: WarningFixId; label: string } | null {
  switch (w.code) {
    case 'floating_region':
    case 'long_bridge':
      return { id: 'supports', label: 'Turn on supports' }
    case 'outside_bed':
    case 'collision':
      return { id: 'arrange', label: 'Arrange' }
    case 'open_edges':
      return w.objectId ? { id: 'repair', label: 'Repair' } : null
    case 'thin_wall':
    case 'unsupported_setting':
      return { id: 'settings', label: 'Edit settings' }
    default:
      return null
  }
}

/** The bed position a warning names ("near X 12.3 Y 4.5 mm"), when it names one. */
export function warningSpot(w: SliceWarning): { x: number; y: number } | null {
  const m = /\bX (-?\d+(?:\.\d+)?)[ ,]+Y (-?\d+(?:\.\d+)?)/.exec(w.message)
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null
}

/** Shows the warning: top layer to its layer (the warning's `layer` is 0 based), its color scheme, its object. */
export function jumpToWarning(w: SliceWarning): void {
  const patch: Partial<ReturnType<typeof get>> = {}
  const n = get().preview?.layerCount ?? 0
  if (w.layer !== undefined && n > 0) {
    patch.layerHi = Math.min(n, w.layer + 1)
    patch.layerLo = 1
    patch.moveCut = 1
  }
  const mode = warningScheme(w)
  if (mode) {
    patch.colorMode = mode
    patch.colorModePicked = true
  }
  if (w.objectId && get().plate.some((p) => p.id === w.objectId)) {
    patch.selection = w.objectId
    patch.selectedIds = [w.objectId]
  }
  set(patch)
  // The camera eases to the spot, at the height of the layer when it has one.
  const spot = warningSpot(w)
  if (spot) cameraBus()?.focusBedPoint?.(spot.x, spot.y, w.layer !== undefined ? (get().preview?.layerZ[w.layer] ?? 0) : 0, { animate: true })
}

/** True when the warning can be fixed with its button right now (supports are not on yet). */
export function fixApplies(w: SliceWarning): boolean {
  const f = warningFix(w)
  if (!f) return false
  return f.id !== 'supports' || get().easy.supports === 'off'
}

export async function runWarningFix(w: SliceWarning, repair: () => Promise<unknown>): Promise<void> {
  const f = warningFix(w)
  if (!f) return
  if (f.id === 'supports') {
    set((s) => ({ easy: { ...s.easy, supports: 'auto' } }))
    markStale()
    toast('Supports are on. Slice again to see them.', 'ok')
  } else if (f.id === 'arrange') {
    const { arrangePlate } = await import('../plate/edit')
    await arrangePlate('all')
    markStale()
  } else if (f.id === 'repair') {
    if (w.objectId) set({ selection: w.objectId, selectedIds: [w.objectId] })
    await repair()
  } else {
    const { setWorkspace } = await import('../state/store')
    setWorkspace('prepare')
  }
}
