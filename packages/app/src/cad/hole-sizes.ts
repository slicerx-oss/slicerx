// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a hole is for, as a size: a screw that passes through, a screw that cuts its own thread in the plastic, or
// a heat-set insert, with a counterbore or a countersink for the head. The table holds usual metric sizes: ISO 273
// medium clearance holes, ISO coarse tap drills, ISO 4762 socket heads and ISO 10642 flat heads, and common
// heat-set insert holes and lengths (they vary by brand). They are a starting point, not yet checked against test
// prints on real printers, and the words say so. A clearance hole is never tighter than the measured fit allows.
import type { HoleSpec } from '../geom/cad'
import type { Clearance } from '../plate/clearance'

export type Thread = 'M2' | 'M2.5' | 'M3' | 'M4' | 'M5' | 'M6' | 'M8'
export const THREADS: readonly Thread[] = ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8']

export type Purpose = 'clearance' | 'tap' | 'insert' | 'custom'
export type Head = 'none' | 'counterbore' | 'countersink'

interface Row {
  /** Screw diameter. */
  nominal: number
  /** ISO 273 medium clearance hole. */
  clearance: number
  /** ISO coarse tap drill: a screw cuts its own thread in a hole this size. */
  tap: number
  /** Heat-set insert hole and insert length. */
  insert: number
  insertLength: number
  /** ISO 4762 socket head diameter and height. */
  head: number
  headHeight: number
  /** ISO 10642 flat head diameter. */
  flatHead: number
}

const ROWS: Record<Thread, Row> = {
  M2: { nominal: 2, clearance: 2.4, tap: 1.6, insert: 3.2, insertLength: 3, head: 3.8, headHeight: 2, flatHead: 4.4 },
  'M2.5': { nominal: 2.5, clearance: 2.9, tap: 2.05, insert: 3.6, insertLength: 4, head: 4.5, headHeight: 2.5, flatHead: 5.5 },
  M3: { nominal: 3, clearance: 3.4, tap: 2.5, insert: 4, insertLength: 5.7, head: 5.5, headHeight: 3, flatHead: 6.72 },
  M4: { nominal: 4, clearance: 4.5, tap: 3.3, insert: 5.6, insertLength: 8.1, head: 7, headHeight: 4, flatHead: 8.96 },
  M5: { nominal: 5, clearance: 5.5, tap: 4.2, insert: 6.4, insertLength: 9.5, head: 8.5, headHeight: 5, flatHead: 11.2 },
  M6: { nominal: 6, clearance: 6.6, tap: 5, insert: 8, insertLength: 12.7, head: 10, headHeight: 6, flatHead: 13.44 },
  M8: { nominal: 8, clearance: 9, tap: 6.8, insert: 9.7, insertLength: 12.7, head: 13, headHeight: 8, flatHead: 17.92 },
}

/** Room around a screw head in its counterbore or countersink, mm. */
const HEAD_ROOM = 1
const HEAD_DEPTH_ROOM = 0.4
/** An insert's hole goes this much deeper than the insert, for the plastic it pushes ahead. */
const INSERT_EXTRA = 1

const mm = (v: number) => `${Number(v.toFixed(2))} mm`
const USUAL = 'These are usual sizes, not yet checked by a test print on this printer.'

export interface HoleChoice {
  purpose: Purpose
  thread: Thread
  head: Head
  /** The diameter for `custom`. */
  customMm?: number
}

/** The hole's new spec for a choice, a short label for its history step, and lines that say how the size was found. */
export function holeSpecFor(c: HoleChoice, fit: Clearance, hole: { through: boolean; depthMm: number }): { spec: HoleSpec; label: string; words: string[] } {
  const r = ROWS[c.thread]
  if (c.purpose === 'custom') {
    const d = c.customMm ?? r.clearance
    return { spec: { diameterMm: d }, label: `Hole ${mm(d)}`, words: [`${mm(d)} as typed.`] }
  }
  const head = c.purpose === 'clearance' ? c.head : 'none'
  const withHead = (spec: HoleSpec): HoleSpec =>
    head === 'counterbore'
      ? { ...spec, counterbore: { diameterMm: r.head + HEAD_ROOM, depthMm: r.headHeight + HEAD_DEPTH_ROOM } }
      : head === 'countersink'
        ? { ...spec, countersink: { diameterMm: Number((r.flatHead + HEAD_DEPTH_ROOM).toFixed(2)), angleDeg: 90 } }
        : spec
  if (c.purpose === 'clearance') {
    const d = Math.max(r.clearance, Number((r.nominal + 2 * fit.mm).toFixed(2)))
    const from = d > r.clearance ? `the measured fit, ${fit.words.charAt(0).toLowerCase()}${fit.words.slice(1)}` : `the usual clearance hole (${fit.words.replace(/\.$/, '')} would be tighter).`
    const headWords = head === 'counterbore' ? [`A counterbore for a socket head.`] : head === 'countersink' ? [`A 90 degree countersink for a flat head.`] : []
    return { spec: withHead({ diameterMm: d }), label: `${c.thread} clearance`, words: [`${mm(d)}: an ${c.thread} screw passes, from ${from}`, ...headWords, USUAL] }
  }
  if (c.purpose === 'tap') {
    return { spec: { diameterMm: r.tap }, label: `${c.thread} tap`, words: [`${mm(r.tap)}: an ${c.thread} screw cuts its own thread.`, USUAL] }
  }
  const depth = r.insertLength + INSERT_EXTRA
  const spec: HoleSpec = hole.through ? { diameterMm: r.insert } : { diameterMm: r.insert, depthMm: Number(depth.toFixed(2)) }
  const deep = hole.through ? '' : `, ${mm(depth)} deep`
  return { spec, label: `${c.thread} insert`, words: [`${mm(r.insert)}${deep}: for an ${c.thread} heat-set insert ${mm(r.insertLength)} long.`, USUAL] }
}
