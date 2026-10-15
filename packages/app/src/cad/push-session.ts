// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The open Push and pull, shared by the places that show it: the arrow and Distance box in the view, the panel in the
// right pane, and the app link. The tool's state lives with the view (push-tool.tsx, usePushTool), so the tool works
// with the pane shut; the panel and the link read it here and change it through the tool's own actions. Also the
// small rules both surfaces share: which operation a distance makes, and how a drag on the arrow turns into a distance.
import { useSyncExternalStore } from 'react'
import type { Vec3 } from '../geom/cad'

/** What a push of a distance does: pull out (adds), cut (removes), or cut through (opens a hole). */
export type PushOp = 'pull' | 'cut' | 'through'

/** The operation chip's words. A negative distance turns into Cut. */
export const OP_LABEL: Record<PushOp, string> = { pull: 'Pull out', cut: 'Cut', through: 'Cut through' }

/** The operation a distance makes on a face the body reaches `thicknessMm` behind (null: no far side). Null for none. */
export function pushOperation(d: number | null, thicknessMm: number | null): PushOp | null {
  if (d === null || !Number.isFinite(d) || d === 0) return null
  if (d > 0) return 'pull'
  return thicknessMm !== null && -d >= thicknessMm - 1e-6 ? 'through' : 'cut'
}

/** A round step near `mm`: 1, 2 or 5 times a power of ten, never under 0.01 mm. */
export function niceStep(mm: number): number {
  if (!(mm > 0.01)) return 0.01
  const p = 10 ** Math.floor(Math.log10(mm))
  const f = mm / p
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p
}

/** Pixels the pointer moves for one drag step on the arrow, before Alt or Shift change it. */
export const STEP_PX = 8

/**
 * The distance a drag on the arrow gives: where it started, plus how far the pointer went along the arrow on screen
 * (pixels, signed toward the face's outside) at `pxPerMm`. It rounds to a step that suits the zoom; Shift rounds to whole
 * millimeters and Alt gives free values (0.01 mm).
 */
export function dragDistance(d0: number, alongPx: number, pxPerMm: number, mods: { alt?: boolean; shift?: boolean } = {}): number {
  const raw = d0 + alongPx / Math.max(pxPerMm, 1e-6)
  const step = mods.alt ? 0.01 : mods.shift ? 1 : niceStep(STEP_PX / Math.max(pxPerMm, 1e-6))
  const v = Math.round(raw / step) * step
  // two decimals at most, and no -0
  return Math.round(v * 100) / 100 || 0
}

/** A distance as the Distance box shows it: no trailing zeros, no -0. */
export function distanceText(d: number): string {
  const v = Math.round(d * 100) / 100 || 0
  return String(v)
}

/** The tool's state as the view, the panel and the link see it. */
export interface PushSnapshot {
  /** The face the tool works on, bed coordinates. */
  face: { objectId: string; partIndex: number; at: Vec3; normal: Vec3; thicknessMm: number | null } | null
  /** The Distance box as typed (mm text; may name values). */
  text: string
  /** The distance it reads as, mm; null while it is empty or does not read. */
  distanceMm: number | null
  busy: boolean
  /** A problem to show (a pick that failed, an engine error). */
  note: string | null
  /** Editing a step of the history: its number from 1. */
  editStep: number | null
}

/** What the open tool does for the panel, the view and the link. */
export interface PushActions {
  setText(text: string): void
  /** Runs the push with the typed distance. True when it went through. */
  apply(): Promise<boolean>
}

let snapshot: PushSnapshot | null = null
let actions: PushActions | null = null
const listeners = new Set<() => void>()

/** The tool publishes its state each time it changes; null when it closes. */
export function publishPush(s: PushSnapshot | null, a: PushActions | null): void {
  if (s === snapshot && a === actions) return
  snapshot = s
  actions = a
  for (const fn of listeners) fn()
}

/** The open tool's state, or null when Push and pull is not open. */
export function pushSnapshot(): PushSnapshot | null {
  return snapshot
}

/** The open tool's actions, or null when Push and pull is not open. */
export function pushActions(): PushActions | null {
  return actions
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** The open tool's state, for React. */
export function usePushSnapshot(): PushSnapshot | null {
  return useSyncExternalStore(subscribe, pushSnapshot, pushSnapshot)
}

// ---------- the arrow on screen ----------

export type V2 = { x: number; y: number }

/** The shortest arrow on screen, so a small distance still has something to grab. */
const MIN_PX = 40
const GAP_PX = 16
const EDGE_PX = 8

/** The arrow on screen: its base on the face, its tip, the face's outside direction and pixels per mm along it. */
export interface ArrowGeom {
  base: V2
  tip: V2
  /** Unit vector on screen toward the face's outside. */
  out: V2
  pxPerMm: number
}

const add = (p: Vec3, n: Vec3, k: number): Vec3 => [p[0] + n[0] * k, p[1] + n[1] * k, p[2] + n[2] * k]

/** Where the arrow for a push of `d` mm on a face at `at` with normal `normal` sits, relative to `origin` (client px). */
export function arrowGeom(screenOf: (p: Vec3) => [number, number] | null, at: Vec3, normal: Vec3, d: number, origin: V2): ArrowGeom | null {
  const s0 = screenOf(at)
  const s1 = screenOf(add(at, normal, 10))
  if (!s0 || !s1) return null
  let ox = s1[0] - s0[0]
  let oy = s1[1] - s0[1]
  let ppm = Math.hypot(ox, oy) / 10
  const facing = ppm * 10 < 3
  if (facing) {
    // The normal points at the camera: the arrow stands up on screen, scaled like the face around it.
    const t: Vec3 = Math.abs(normal[2]) < 0.9 ? [normal[1], -normal[0], 0] : [0, normal[2], -normal[1]]
    const tl = Math.hypot(...t) || 1
    const st = screenOf(add(at, [t[0] / tl, t[1] / tl, t[2] / tl], 10))
    ppm = st ? Math.max(Math.hypot(st[0] - s0[0], st[1] - s0[1]) / 10, 0.1) : 1
    ox = 0
    oy = -1
  } else {
    ox /= ppm * 10
    oy /= ppm * 10
  }
  const base = { x: s0[0] - origin.x, y: s0[1] - origin.y }
  const sgn = d < 0 ? -1 : 1
  const far = !facing && Math.abs(d) * ppm >= MIN_PX ? screenOf(add(at, normal, d)) : null
  const tip = far ? { x: far[0] - origin.x, y: far[1] - origin.y } : { x: base.x + ox * sgn * Math.max(Math.abs(d) * ppm, MIN_PX), y: base.y + oy * sgn * Math.max(Math.abs(d) * ppm, MIN_PX) }
  return { base, tip, out: { x: ox, y: oy }, pxPerMm: ppm }
}

/** The Distance box's top left beside the tip, kept inside the view. */
export function boxSpot(tip: V2, box: { w: number; h: number }, view: { w: number; h: number }): V2 {
  const x = Math.max(EDGE_PX, Math.min(view.w - box.w - EDGE_PX, tip.x + GAP_PX))
  const y = Math.max(EDGE_PX, Math.min(view.h - box.h - EDGE_PX, tip.y - box.h / 2))
  return { x: Math.round(x), y: Math.round(y) }
}
