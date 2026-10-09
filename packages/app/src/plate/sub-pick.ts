// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A click in Model with Faces or Edges in the pick filter: the face or edge under it is picked, and its object is the
// selection. Shift adds, Cmd or Ctrl toggles, a plain click picks just that one, and a click on empty space clears.
// A tool opened next takes the picks as if they were its first clicks (cad/panel-kit.tsx).
import type { PickEvent } from '@slicerx/viewport'
import { get, set, type SubPick } from '../state/store'
import { DEFAULT_FILTER, nextFilter, type PickKind } from './pick-filter'

type Vec3 = [number, number, number]

type Lines = { from: Vec3; to: Vec3 }[]

/** The edge under a click, as lines to draw, or null when there is no edge to pick there. */
export type EdgeAt = (objectId: string, partIndex: number, triangle: number, at: Vec3) => Promise<Lines | null>

const near = (a: Vec3, b: Vec3) => a.every((v, k) => Math.abs(v - b[k]!) < 1e-4)

/** Same face or edge: the same patch is hard to know without the engine, so the same triangle, or ends that match. */
function same(a: SubPick, b: SubPick): boolean {
  if (a.kind !== b.kind || a.objectId !== b.objectId || a.partIndex !== b.partIndex) return false
  const la = a.lines?.[0]
  const lb = b.lines?.[0]
  if (a.kind === 'edge' && la && lb) return (near(la.from, lb.from) && near(la.to, lb.to)) || (near(la.from, lb.to) && near(la.to, lb.from))
  return a.triangle === b.triangle
}

/** The picks after one click: Shift adds, Cmd or Ctrl toggles, plain replaces. Picks on other objects go. */
export function addPick(cur: readonly SubPick[], pick: SubPick, mode: { shift?: boolean | undefined; toggle?: boolean | undefined }): SubPick[] {
  const kept = cur.filter((p) => p.objectId === pick.objectId)
  if (mode.toggle) return kept.some((p) => same(p, pick)) ? kept.filter((p) => !same(p, pick)) : [...kept, pick]
  if (mode.shift) return kept.some((p) => same(p, pick)) ? kept : [...kept, pick]
  return [pick]
}

/**
 * Handles a Model click with faces or edges in the filter. True when it did (the click picked or cleared a face or
 * an edge); false leaves it to the ordinary object selection.
 */
export async function pickSub(e: PickEvent, edgeAt: EdgeAt): Promise<boolean> {
  const filter = get().pickFilter
  const faces = filter.includes('face')
  const edges = filter.includes('edge')
  if (!faces && !edges) return false
  if (!e.objectId || e.partIndex === null || e.triangle === null || !e.point) {
    if (get().subPicks.length) set({ subPicks: [] })
    return false
  }
  const base = { objectId: e.objectId, partIndex: e.partIndex, triangle: e.triangle, point: e.point }
  let pick: SubPick | null = null
  // Faces first when both are on: a click on a face picks the face; Edges alone pick the nearest edge.
  if (faces) pick = { kind: 'face', ...base }
  else {
    const lines = await edgeAt(e.objectId, e.partIndex, e.triangle, e.point).catch(() => null)
    if (!lines) return true
    pick = { kind: 'edge', ...base, lines }
  }
  const objectId = e.objectId
  set((s) => ({ subPicks: addPick(s.subPicks, pick, e), selection: objectId, selectedIds: [objectId], towerSelected: false }))
  return true
}

/** Esc: the faces and edges go first, then the object selection. True when it cleared something. */
export function clearPicks(): boolean {
  const s = get()
  if (s.subPicks.length) {
    set({ subPicks: [] })
    return true
  }
  return false
}

/** Alt+1, Alt+2, Alt+3 and their Shift forms. Picks of a kind the filter drops go with it. */
export function setPickKind(kind: PickKind, mode: 'only' | 'toggle'): void {
  set((s) => {
    const pickFilter = nextFilter(s.pickFilter, kind, mode)
    return { pickFilter, subPicks: s.subPicks.filter((p) => pickFilter.includes(p.kind)) }
  })
}

/** Takes the picks for a tool as it opens: faces for a face tool, else edges, else faces. They are cleared. */
export function takePicks(faces: boolean): SubPick[] {
  const all = get().subPicks
  if (!all.length) return []
  const f = all.filter((p) => p.kind === 'face')
  const ed = all.filter((p) => p.kind === 'edge')
  set({ subPicks: [] })
  return faces ? f : ed.length ? ed : f
}

export { DEFAULT_FILTER }
