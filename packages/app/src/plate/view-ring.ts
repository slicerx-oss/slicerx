// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where Model's ring menu in the 3D view is open and what it is for, set by the view's `contextpick` and read by the
// ring (workspaces/design/view-ring.tsx). Light, so the viewport host can open it without loading the ring.
import { createStore } from 'zustand'
import type { AppState } from '../state/store'

export type RingKind = 'object' | 'face' | 'edge' | 'empty'

/** What a ring is for: an object, the picked faces or edges of one, or empty space. */
export type RingTarget = { kind: 'empty' } | { kind: 'object'; objectId: string } | { kind: 'face' | 'edge'; objectId: string; count: number }

/** The target from the picks and the selection after the right click: faces or edges first, then the object. */
export function ringTarget(s: Pick<AppState, 'subPicks' | 'selection'>): RingTarget {
  const last = s.subPicks.at(-1)
  if (last) return { kind: last.kind, objectId: last.objectId, count: s.subPicks.filter((p) => p.kind === last.kind).length }
  return s.selection ? { kind: 'object', objectId: s.selection } : { kind: 'empty' }
}

/** Where the ring or its full list is open. */
export const viewRing = createStore<{ at: { x: number; y: number } | null; target: RingTarget; list: boolean }>()(() => ({ at: null, target: { kind: 'empty' }, list: false }))

export function openViewRing(at: { x: number; y: number }, target: RingTarget): void {
  viewRing.setState({ at, target, list: false })
}

export function closeViewRing(): void {
  viewRing.setState({ at: null, list: false })
}

/** More: the full list at the same point. */
export function ringList(): void {
  viewRing.setState((s) => ({ at: s.at, list: true }))
}

/** Lays an object on the face picked in Model; the viewport host sets it, since it knows the face's normal. */
let layFace: ((objectId: string) => boolean) | null = null
export function setLayFace(fn: ((objectId: string) => boolean) | null): void {
  layFace = fn
}
export function layPickedFace(objectId: string): boolean {
  return layFace?.(objectId) ?? false
}
