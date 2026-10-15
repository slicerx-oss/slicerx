// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Select Other's work, loaded on first use (select-other.ts holds the light half). What is under a spot: the list leads
// with what a plain click picks (an edge near the pointer, else the face), then every face front to back, then every
// body front to back. A plain click on the same spot again steps to the next one; a hold opens the list; Alt+S opens it
// from the keyboard; clients list and pick through the app link (select.under, select.other).
import type { PickAllHit, PickEvent } from '@slicerx/viewport'
import { LinkError } from '../app-link/methods-error'
import { get, set, toast, type SubPick } from '../state/store'
import { EDGE_WINS_PX, pickReadout, screenDistance, type PickKind } from './pick-filter'
import { addPick } from './sub-pick'
import { candidateWords, openOtherList, otherView, selectOther, selectOtherOn, withoutFraming, type OtherCandidate } from './select-other'

type Vec3 = [number, number, number]
type Lines = { from: Vec3; to: Vec3 }[]

/** The edge of the nearest face at the spot, as the engine finds it, and whether it lies near enough to win a click. */
export interface EdgeUnder {
  lines: Lines
  near: boolean
}

/** A face's plain name from its outward normal in the bed frame (Z up, the front of the bed toward -Y). */
export function faceLabel(n: readonly number[], round = false): string {
  if (round) return 'Round face'
  const [x = 0, y = 0, z = 0] = n
  if (z > 0.9) return 'Top face'
  if (z < -0.9) return 'Bottom face'
  if (Math.abs(z) > 0.25) return 'Sloped face'
  return Math.abs(x) > Math.abs(y) ? (x < 0 ? 'Left face' : 'Right face') : y < 0 ? 'Front face' : 'Back face'
}

export const patchKey = (h: { objectId: string; partIndex: number; patch: number }) => `${h.objectId}:${h.partIndex}:${h.patch}`

/**
 * Everything under the spot, in the order the list shows and repeated clicks step through. Face (an edge near the
 * pointer still wins): that edge, then every face front to back, then every body front to back. Edge only: the edge
 * under the pointer, then the bodies. Body: the bodies. `round` holds the faces the engine found round (patchKey).
 */
export function buildCandidates(o: { hits: readonly PickAllHit[]; edge: EdgeUnder | null; filter: readonly PickKind[]; names: Readonly<Record<string, string>>; round?: ReadonlySet<string> }): OtherCandidate[] {
  const { hits, edge, filter, names } = o
  const front = hits[0]
  if (!front) return []
  const faces = filter.includes('face')
  const edges = filter.includes('edge')
  const name = (id: string) => names[id] ?? 'Object'
  const out: OtherCandidate[] = []
  // Edge only takes the nearest face's edge wherever the pointer is on that face; with Face it has to be near enough to win.
  if (edge && ((edges && !faces) || edge.near)) {
    const round = edge.lines.length > 1
    out.push({ kind: 'edge', objectId: front.objectId, partIndex: front.partIndex, triangle: front.triangle, point: front.point, depth: front.depth, lines: edge.lines, ...(round ? { round: true } : {}), label: round ? 'Round edge' : 'Straight edge', object: name(front.objectId) })
  }
  if (faces)
    for (const h of hits) {
      const round = o.round?.has(patchKey(h)) ?? false
      out.push({ kind: 'face', objectId: h.objectId, partIndex: h.partIndex, triangle: h.triangle, patch: h.patch, point: h.point, depth: h.depth, ...(round ? { round: true } : {}), label: faceLabel(h.normal, round), object: name(h.objectId) })
    }
  const bodies = new Set<string>()
  for (const h of hits) {
    if (bodies.has(h.objectId)) continue
    bodies.add(h.objectId)
    out.push({ kind: 'body', objectId: h.objectId, partIndex: h.partIndex, triangle: h.triangle, point: h.point, depth: h.depth, label: 'Body', object: name(h.objectId) })
  }
  return out
}

const near = (a: Vec3, b: Vec3) => a.every((v, k) => Math.abs(v - b[k]!) < 1e-4)
const r3 = (v: number) => Math.round(v * 1000) / 1000

/** A list's identity: the same things under the spot give the same key, wherever on each face the pointer is. */
export function candidatesKey(list: readonly OtherCandidate[]): string {
  return list
    .map((c) => {
      const l = c.lines?.[0]
      const at = c.kind === 'face' ? `p${c.patch ?? c.triangle}` : c.kind === 'edge' && l ? [...l.from, ...l.to].map(r3).join(',') : ''
      return `${c.kind}:${c.objectId}:${c.kind === 'body' ? '' : c.partIndex}:${at}`
    })
    .join('|')
}

type Sel = { subPicks: readonly SubPick[]; selectedIds: readonly string[] }

/** Which candidate the selection is now, or -1: one face, one edge, or a body selected with nothing on it. */
export function candidateIndex(list: readonly OtherCandidate[], s: Sel): number {
  if (s.subPicks.length > 1) return -1
  const p = s.subPicks[0]
  if (!p) return s.selectedIds.length === 1 ? list.findIndex((c) => c.kind === 'body' && c.objectId === s.selectedIds[0]) : -1
  return list.findIndex((c) => {
    if (c.kind !== p.kind || c.objectId !== p.objectId || c.partIndex !== p.partIndex) return false
    const a = c.lines?.[0]
    const b = p.lines?.[0]
    if (c.kind === 'edge' && a && b) return (near(a.from, b.from) && near(a.to, b.to)) || (near(a.from, b.to) && near(a.to, b.from))
    return c.triangle === p.triangle
  })
}

/** The selection as a later click compares it: what was picked, not how (a face found round later counts the same). */
export function selectionSig(s: Sel): string {
  return `${s.subPicks.map((p) => `${p.kind}:${p.objectId}:${p.partIndex}:${p.triangle}`).join(',')}|${s.selectedIds.join(',')}`
}

/** A click again within this many pixels of the last one counts as the same spot. */
export const SAME_SPOT_PX = 4
/** Two clicks closer together than this are a double click (which may frame the object), not a step, ms. */
export const DOUBLE_CLICK_MS = 300

/** The last plain click in Model, to know whether the next one is on the same spot. */
export interface ClickMemo {
  at: readonly [number, number]
  key: string
  time: number
  /** The selection that click left (selectionSig): anything picked since starts over. */
  sig: string
}

const sameSpot = (memo: ClickMemo, at: readonly [number, number]) => Math.hypot(at[0] - memo.at[0], at[1] - memo.at[1]) <= SAME_SPOT_PX

/**
 * What a plain click does: `fresh` picks the top candidate as any click does, `step` moves on to the next one, and
 * `double` is the second click of a double click, which leaves the pick alone.
 */
export function clickStep(memo: ClickMemo | null, at: readonly [number, number], key: string, now: number, sig: string): 'fresh' | 'step' | 'double' {
  if (!memo || !sameSpot(memo, at) || memo.key !== key || memo.sig !== sig) return 'fresh'
  return now - memo.time < DOUBLE_CLICK_MS ? 'double' : 'step'
}

/** The pick for one candidate, as a click would make it; null for a body. */
export function subPickOf(c: OtherCandidate): SubPick | null {
  if (c.kind === 'body') return null
  return { kind: c.kind, objectId: c.objectId, partIndex: c.partIndex, triangle: c.triangle, point: c.point, ...(c.lines ? { lines: c.lines } : {}), ...(c.round ? { round: true } : {}) }
}

/**
 * Picks one candidate: a face or an edge (Shift adds, Cmd or Ctrl toggles, as a click does), or a whole body. The view
 * keeps its camera, so what was under the spot stays under it.
 */
export function applyCandidate(c: OtherCandidate, mode: { shift?: boolean; toggle?: boolean } = {}): void {
  const pick = subPickOf(c)
  withoutFraming(() => {
    if (!pick) set({ subPicks: [], selection: c.objectId, selectedIds: [c.objectId], towerSelected: false })
    else set((s) => ({ subPicks: addPick(s.subPicks, pick, mode), selection: c.objectId, selectedIds: [c.objectId], towerSelected: false }))
  })
}

/** At most this many faces are named round by the engine; any behind them are named by the way they face. */
const ROUND_ASKS = 6

/** Everything under a client point, with plain names. Empty off the models or without the view. */
export async function candidatesAt(at: readonly [number, number], under?: readonly PickAllHit[]): Promise<OtherCandidate[]> {
  const v = otherView()
  if (!v) return []
  const hits = under ?? v.pickAll(at[0], at[1])
  const front = hits[0]
  if (!front) return []
  const s = get()
  const filter = s.pickFilter
  const faces = filter.includes('face')
  const lines = faces || filter.includes('edge') ? await v.edgeAt(front.objectId, front.partIndex, front.triangle, front.point).catch(() => null) : null
  const edge = lines ? { lines, near: screenDistance([at[0], at[1]], lines, (p) => v.screenOf(p)) <= EDGE_WINS_PX } : null
  const round = new Set<string>()
  if (faces)
    await Promise.all(
      hits.slice(0, ROUND_ASKS).map(async (h) => {
        if (await v.faceRound(h.objectId, h.partIndex, h.triangle, h.point).catch(() => false)) round.add(patchKey(h))
      }),
    )
  const names: Record<string, string> = {}
  for (const p of s.plate) names[p.id] = p.name
  return buildCandidates({ hits, edge, filter, names, round })
}

/**
 * A press or a finger held still: the list of everything that was under it when it began (`under`). A finger held on
 * empty space opens the ring there, as it did before Select Other.
 */
export async function holdAt(at: readonly [number, number], touch: boolean, under?: readonly PickAllHit[]): Promise<void> {
  const list = await candidatesAt(at, under)
  if (!selectOtherOn(get())) return
  if (list.length) openOtherList({ at: { x: at[0], y: at[1] }, list, touch })
  else if (touch) otherView()?.ring([at[0], at[1]])
}

/** Alt+S: the list at the pointer's spot over the view, else at the last pick, else the middle of the view. */
export async function openFromKeys(): Promise<void> {
  const v = otherView()
  if (!v) return
  const last = get().subPicks.at(-1)
  const r = v.rect()
  const at = v.pointer() ?? (last ? v.screenOf(last.point) : null) ?? [r.left + r.width / 2, r.top + r.height / 2]
  const list = await candidatesAt(at)
  if (!list.length) return toast('Nothing under the pointer to pick. Point at the model, then press Alt+S.', 'info')
  openOtherList({ at: { x: at[0], y: at[1] }, list, touch: false })
}

let memo: ClickMemo | null = null

function showTag(at: readonly [number, number], list: readonly OtherCandidate[], i: number): void {
  const c = list[i]
  selectOther.setState({ tag: list.length > 1 && c ? { at: { x: at[0], y: at[1] }, label: candidateWords(c), index: i, count: list.length } : null })
}

async function remember(at: readonly [number, number], time: number): Promise<void> {
  const list = await candidatesAt(at)
  const s = get()
  memo = { at, key: candidatesKey(list), time, sig: selectionSig(s) }
  const i = candidateIndex(list, s)
  if (i >= 0) showTag(at, list, i)
}

/**
 * A plain click in Model: the first on a spot picks as any click does (`click`); the same spot again steps to the
 * next thing under it, around to the first after the last. The tag beside the pointer says which one of how many.
 */
export async function clickAt(e: PickEvent, click: () => Promise<void>): Promise<void> {
  const at = e.screen
  const now = performance.now()
  if (!at) return click()
  if (memo && sameSpot(memo, at)) {
    const list = await candidatesAt(at)
    const s = get()
    const step = clickStep(memo, at, candidatesKey(list), now, selectionSig(s))
    if (step === 'double') {
      memo = { ...memo, time: now }
      return
    }
    if (step === 'step' && list.length > 1) {
      const i = (candidateIndex(list, s) + 1) % list.length
      applyCandidate(list[i]!)
      memo = { at, key: candidatesKey(list), time: now, sig: selectionSig(get()) }
      showTag(at, list, i)
      return
    }
  }
  selectOther.setState({ tag: null })
  await click()
  await remember(at, now)
}

/** Forgets the last click (the view moved, so the same spot is something else now). */
export function forgetClick(): void {
  memo = null
}

/** A client's spot: view pixels from the view's top left corner, or a bed point (mm) put on screen. */
function clientPoint(args: Record<string, unknown>): { client: [number, number]; at: { x: number; y: number }; view: { width: number; height: number } } {
  const extra = Object.keys(args).filter((k) => !['x', 'y', 'pointMm', 'index'].includes(k))
  if (extra.length) throw new LinkError('invalid_input', `takes x and y, or pointMm, and index; not ${extra.join(', ')}`)
  const v = otherView()
  if (!v || !selectOtherOn(get())) throw new LinkError('not_ready', 'open Model with no tool open first: Select Other picks in its view')
  const r = v.rect()
  let x: number
  let y: number
  const p = args['pointMm']
  if (p !== undefined) {
    if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new LinkError('invalid_input', 'pointMm: three numbers, a bed point in mm')
    const sc = v.screenOf(p as Vec3)
    if (!sc) throw new LinkError('not_ready', 'the view has no camera yet')
    x = sc[0] - r.left
    y = sc[1] - r.top
  } else {
    const ax = args['x']
    const ay = args['y']
    if (typeof ax !== 'number' || typeof ay !== 'number' || !Number.isFinite(ax) || !Number.isFinite(ay)) throw new LinkError('invalid_input', 'give x and y (view pixels from its top left corner), or pointMm')
    x = ax
    y = ay
  }
  if (x < 0 || y < 0 || x > r.width || y > r.height) throw new LinkError('invalid_input', `that spot is outside the view (${Math.round(r.width)} x ${Math.round(r.height)} px)`)
  return { client: [r.left + x, r.top + y], at: { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }, view: { width: Math.round(r.width), height: Math.round(r.height) } }
}

const mm = (v: readonly number[]) => v.map((n) => Math.round(n * 1000) / 1000)

function candidateOut(c: OtherCandidate, index: number) {
  return { index, kind: c.kind, label: c.label, object: c.object, objectId: c.objectId, ...(c.kind === 'body' ? {} : { part: c.partIndex, triangle: c.triangle }), ...(c.round ? { round: true } : {}), pointMm: mm(c.point), depthMm: Math.round(c.depth * 100) / 100 }
}

/** The selection read back, as the selection pill says it. */
export function selectionOut() {
  const s = get()
  const names: Record<string, string> = {}
  for (const p of s.plate) names[p.id] = p.name
  const ids = s.selection ? [s.selection, ...s.selectedIds.filter((id) => id !== s.selection)] : [...s.selectedIds]
  const on = (kind: 'face' | 'edge') => s.subPicks.filter((p) => p.kind === kind).map((p) => ({ object: names[p.objectId] ?? 'an object' }))
  return {
    readout: pickReadout({ objects: ids.map((id) => names[id]).filter((n): n is string => n !== undefined), faces: on('face'), edges: on('edge') }),
    selectedIds: ids,
    picks: s.subPicks.map((p) => ({ kind: p.kind, objectId: p.objectId, part: p.partIndex, triangle: p.triangle, ...(p.round ? { round: true } : {}) })),
  }
}

/** select.under: everything under a spot of Model's view, in the list's order. Reads only. */
export async function linkUnder(args: Record<string, unknown>) {
  if (args['index'] !== undefined) throw new LinkError('invalid_input', 'select.under takes no index; select.other picks one')
  const { client, at, view } = clientPoint(args)
  const list = await candidatesAt(client)
  return { at, view, candidates: list.map(candidateOut) }
}

/** select.other: picks the candidate at `index` under a spot, as choosing it from the list does; the selection read back. */
export async function linkPick(args: Record<string, unknown>) {
  const index = args['index']
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new LinkError('invalid_input', 'index: a whole number from 0, from select.under')
  const { client, at, view } = clientPoint(args)
  const list = await candidatesAt(client)
  const c = list[index]
  if (!c) throw new LinkError('invalid_input', list.length ? `index: 0 to ${list.length - 1} at this spot` : 'nothing is under that spot')
  applyCandidate(c)
  return { at, view, picked: candidateOut(c, index), candidates: list.map(candidateOut), selection: selectionOut() }
}
