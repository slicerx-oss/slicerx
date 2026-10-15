// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's Select Other, the light half that loads with the view: whether it is on, the open list and the tag beside the
// pointer, and the view's calls it needs. Holding the pointer or a finger still on a spot for half a second opens a
// list of everything under it; clicking the same spot again steps to the next thing there. The work (what is under a
// spot, the click steps, the app link's answers) loads on first use from select-other-pick.ts; the list is drawn by
// workspaces/design/select-other-list.tsx.
import { createStore } from 'zustand'
import type { PickAllHit } from '@slicerx/viewport'
import { modelFeelFor } from '../cad/model-feel-flag'
import type { ModelMode } from '../state/store'

type Vec3 = [number, number, number]
type Lines = { from: Vec3; to: Vec3 }[]

export type OtherKind = 'edge' | 'face' | 'body'

/** One thing under the spot, with its plain name. */
export interface OtherCandidate {
  kind: OtherKind
  objectId: string
  /** The part and triangle hit (a body: its nearest hit). */
  partIndex: number
  triangle: number
  /** A face's flat patch, the same for any hit on it. */
  patch?: number
  /** Where the ray meets it, bed coordinates (mm). */
  point: Vec3
  /** Distance from the eye, mm: each kind runs front to back. */
  depth: number
  /** An edge, as lines to draw. */
  lines?: Lines
  round?: boolean
  /** What it is, in plain words: "Top face", "Round edge", "Body". */
  label: string
  /** The object it is on, by its name. */
  object: string
}

/** The open list: where, what is in it, and whether a finger opened it (bigger rows, and the ring one tap away). */
export interface OtherList {
  at: { x: number; y: number }
  list: OtherCandidate[]
  touch: boolean
}

/** The tag beside the pointer after a click on a spot with more than one thing under it: which one of how many. */
export interface OtherTag {
  at: { x: number; y: number }
  label: string
  index: number
  count: number
}

export const selectOther = createStore<{ open: OtherList | null; hover: OtherCandidate | null; tag: OtherTag | null }>()(() => ({ open: null, hover: null, tag: null }))

export function openOtherList(open: OtherList): void {
  selectOther.setState({ open, hover: null, tag: null })
}

export function closeOtherList(): void {
  const s = selectOther.getState()
  if (s.open || s.hover) selectOther.setState({ open: null, hover: null })
}

export function hideOtherTag(): void {
  if (selectOther.getState().tag) selectOther.setState({ tag: null })
}

/** The words for a candidate in the tag and the list: "Top face on Bracket". */
export function candidateWords(c: Pick<OtherCandidate, 'label' | 'object'>): string {
  return `${c.label} on ${c.object}`
}

/** On in Model's view with no tool open, with the Model feel (the mimir tab's view picks its own way). */
export function selectOtherOn(s: { workspace: string; modelMode: ModelMode; objectTool: string | null; settingsMode: string }): boolean {
  return s.workspace === 'prepare' && s.modelMode === 'design' && s.objectTool === null && modelFeelFor(s.settingsMode)
}

/** What Select Other asks of the 3D view; the viewport host gives it while Model's view is up. */
export interface OtherView {
  /** Everything under a client point, front to back. */
  pickAll(clientX: number, clientY: number): PickAllHit[]
  /** The edge the engine finds at a point of a triangle, as lines, or null. */
  edgeAt(objectId: string, partIndex: number, triangle: number, at: Vec3): Promise<Lines | null>
  /** Whether the face around a triangle is round, from the engine. */
  faceRound(objectId: string, partIndex: number, triangle: number, at: Vec3): Promise<boolean>
  /** A bed point on screen, client pixels. */
  screenOf(p: Vec3): [number, number] | null
  /** The view's box on the page, client pixels. */
  rect(): { left: number; top: number; width: number; height: number }
  /** Opens Model's ring for what is under a client point (the list's More actions, on a phone). */
  ring(at: [number, number]): void
  /** Where the pointer last rested over the view, client pixels, or null. */
  pointer(): [number, number] | null
  /** Gives focus back to the view (the list closed). */
  focus(): void
}

let view: OtherView | null = null

export function setOtherView(v: OtherView | null): void {
  view = v
}

export function otherView(): OtherView | null {
  return view
}

let framingHeld = false

/** Runs a Select Other pick without Model framing the view on it: the next click on the same spot must find the same things. */
export function withoutFraming(fn: () => void): void {
  framingHeld = true
  try {
    fn()
  } finally {
    framingHeld = false
  }
}

/** True while a Select Other pick is being made: the view keeps its camera. */
export function framingIsHeld(): boolean {
  return framingHeld
}

/** Loads the work on first use. */
export const otherPick = () => import('./select-other-pick')
