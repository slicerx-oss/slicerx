// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a click picks in Model: whole objects, faces or edges. Alt+1, Alt+2 and Alt+3 pick one kind; with Shift they
// add or drop that kind and keep the others. Bare digits stay the view keys, and sketch mode picks its own lines and
// points, so the keys rest there. The readout says what is picked in plain words.
import { matchShortcut } from '../lib/keys'

export type PickKind = 'object' | 'face' | 'edge'

export const PICK_KINDS: readonly PickKind[] = ['object', 'face', 'edge']

/** The chord for each kind; Shift on top adds or drops it. */
export const PICK_KEYS: Readonly<Record<PickKind, string>> = { object: 'Alt+1', face: 'Alt+2', edge: 'Alt+3' }

export const PICK_LABEL: Readonly<Record<PickKind, { label: string; tip: string }>> = {
  object: { label: 'Objects', tip: 'Pick whole objects' },
  face: { label: 'Faces', tip: 'Pick faces' },
  edge: { label: 'Edges', tip: 'Pick edges' },
}

export const DEFAULT_FILTER: readonly PickKind[] = ['object']

/** With the new Model feel, the labels read as modes: Face (edges near the pointer still win), Edge only, Body. */
export const PICK_LABEL_FEEL: Readonly<Record<PickKind, { label: string; tip: string }>> = {
  object: { label: 'Body', tip: 'Pick whole bodies' },
  face: { label: 'Face', tip: 'Pick faces; an edge within 6 px of the pointer is picked instead' },
  edge: { label: 'Edge only', tip: 'Pick edges only' },
}

/** How near the pointer (client px) an edge must be to win over the face under it, with the new Model feel. */
export const EDGE_WINS_PX = 6

type P2 = readonly [number, number]

/** The pointer's distance in pixels to the nearest of the lines, each end put on screen by `toScreen`. */
export function screenDistance(at: P2, lines: readonly { from: [number, number, number]; to: [number, number, number] }[], toScreen: (p: [number, number, number]) => P2 | null): number {
  let best = Infinity
  for (const l of lines) {
    const a = toScreen(l.from)
    const b = toScreen(l.to)
    if (!a || !b) continue
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dy) / len2)) : 0
    best = Math.min(best, Math.hypot(at[0] - (a[0] + dx * t), at[1] - (a[1] + dy * t)))
  }
  return best
}

/** `only` picks just this kind; `toggle` adds or drops it, and never leaves nothing picked. Kept in PICK_KINDS order. */
export function nextFilter(cur: readonly PickKind[], kind: PickKind, mode: 'only' | 'toggle'): PickKind[] {
  if (mode === 'only') return [kind]
  const on = cur.includes(kind) ? cur.filter((k) => k !== kind) : [...cur, kind]
  return on.length ? PICK_KINDS.filter((k) => on.includes(k)) : [kind]
}

/** The keys work in Model's and mimir's view only, and rest while a sketch is open (it picks its own lines and points). */
export function pickKeysOn(s: { workspace: string; modelMode: string; objectTool: string | null }): boolean {
  return s.workspace === 'prepare' && (s.modelMode === 'design' || s.modelMode === 'mimir') && s.objectTool !== 'sketch'
}

/** The kind and mode a key event asks for, or null. */
export function pickKeyOf(e: KeyboardEvent): { kind: PickKind; mode: 'only' | 'toggle' } | null {
  for (const kind of PICK_KINDS) {
    if (matchShortcut(e, PICK_KEYS[kind])) return { kind, mode: 'only' }
    if (matchShortcut(e, `Shift+${PICK_KEYS[kind]}`)) return { kind, mode: 'toggle' }
  }
  return null
}

export interface Picked {
  /** The selected objects' names, primary first. */
  objects: readonly string[]
  /** Faces and edges picked, with the object each is on. */
  faces?: readonly { object: string }[]
  edges?: readonly { object: string }[]
}

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`)

/** The pill's words: "Nothing selected", "Bracket", "3 objects", "2 faces on Bracket", "4 edges on 2 objects". */
export function pickReadout(p: Picked): string {
  const faces = p.faces ?? []
  const edges = p.edges ?? []
  const subs = faces.length ? { n: faces.length, one: 'face', many: 'faces' } : edges.length ? { n: edges.length, one: 'edge', many: 'edges' } : null
  if (subs) {
    const on = new Set([...faces, ...edges].map((x) => x.object))
    const where = on.size === 1 ? [...on][0]! : `${on.size} objects`
    const what = count(subs.n, subs.one, subs.many)
    // faces and edges at once: the faces lead, the edges follow
    return faces.length && edges.length ? `${what} and ${count(edges.length, 'edge', 'edges')} on ${where}` : `${what} on ${where}`
  }
  if (!p.objects.length) return 'Nothing selected'
  return p.objects.length === 1 ? p.objects[0]! : `${p.objects.length} objects`
}
