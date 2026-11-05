// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Exploded view: the selected objects with 2 parts or more drawn with their parts moved apart, for a look inside an
// assembly. It lives in AppState.explode and nowhere else: the slice, export, undo history and saved project never read
// it, and it goes back to 0 when the selection changes or a project opens (store.ts). The view draws it (setExplode);
// what it drew is read back here for the app link, kept out of the view's module so the link does not load the view.
import { EXPLODE_AXES, clampSpread, type ExplodeAxis, type Vec3 } from '@slicerx/contracts/explode'
import { cadShown, showsDesign } from '../state/model-mode'
import { get, selectedIds, set, type AppState } from '../state/store'

export { EXPLODE_AXES, type ExplodeAxis }

/** The selected objects the exploded view spreads: those with 2 parts or more. */
export function explodeTargets(s: Pick<AppState, 'plate' | 'selection' | 'selectedIds'> = get()): string[] {
  const chosen = new Set(selectedIds(s))
  return s.plate.filter((p) => chosen.has(p.id) && p.parts.length > 1).map((p) => p.id)
}

/** Whether the plate view draws the slice's toolpaths in place of the models: then there is nothing to spread. The bar and the view both ask this. */
export function toolpathsDrawn(s: Pick<AppState, 'workspace' | 'modelMode' | 'sliceLook' | 'preview'>): boolean {
  return s.workspace === 'prepare' && !(showsDesign(s) && cadShown()) && s.sliceLook === 'toolpaths' && s.preview !== null
}

/** Whether the Spread control shows: something to spread, and the plate drawn as models (not as the slice's toolpaths). */
export function explodeShown(s: Pick<AppState, 'plate' | 'selection' | 'selectedIds'>, toolpaths: boolean): boolean {
  return !toolpaths && explodeTargets(s).length > 0
}

/** What the view is asked to draw, or null for every part at home. */
export function explodeSpec(s: Pick<AppState, 'plate' | 'selection' | 'selectedIds' | 'explode'>, toolpaths: boolean): { ids: string[]; spread: number; axis: ExplodeAxis; parts: Record<string, number> } | null {
  if (toolpaths || s.explode.spread <= 0) return null
  const ids = explodeTargets(s)
  // the parts each prints: its volumes (modifiers, blockers, negative parts) are drawn after them and stay with it
  const parts = Object.fromEntries(s.plate.filter((p) => ids.includes(p.id)).map((p) => [p.id, p.parts.length]))
  return ids.length ? { ids, spread: s.explode.spread, axis: s.explode.axis, parts } : null
}

/** Sets the spread (0 to 100 percent, whole numbers) and, when given, the axis. Not an edit of the project. */
export function setExplode(change: { spread?: number; axis?: ExplodeAxis }): void {
  const was = get().explode
  const spread = change.spread === undefined ? was.spread : Math.round(clampSpread(change.spread))
  const axis = change.axis ?? was.axis
  if (spread === was.spread && axis === was.axis) return
  set({ explode: { spread, axis } })
}

let source: (() => Record<string, Vec3[]>) | null = null

/** The view started: it answers the offsets it draws parts at. Returns the call that lets go when the view goes. */
export function explodedFrom(read: () => Record<string, Vec3[]>): () => void {
  source = read
  return () => {
    if (source === read) source = null
  }
}

/** The offsets the view draws each spread object's parts at now (bed mm, one per part), or null when no 3D view is up. */
export function explodedNow(): Record<string, Vec3[]> | null {
  return source ? source() : null
}
