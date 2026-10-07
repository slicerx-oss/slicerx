// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the objects list says about the fit check: one line per kind of problem. Loaded with the notes, not at startup.
import type { ObjectFit, Touch } from './fit-state'

export interface FitNote {
  kind: 'touch' | 'apart' | 'horizontal' | 'vertical'
  /** One line: what and why. */
  text: string
  /** What Show which lists. */
  which: string[]
  /** Touch: the other objects. Vertical: the layer height that keeps every gap open. */
  others?: string[]
  layerMm?: number
}

const mm = (v: number) => `${v.toFixed(2)} mm`
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** One note per kind of problem, never one per pair. */
export function fitNotes(id: string, fit: ObjectFit | undefined, touches: readonly Touch[], nameOf: (id: string) => string, layerHeightMm: number): FitNote[] {
  const out: FitNote[] = []
  const mine = touches.filter((t) => t.ids.includes(id))
  if (mine.length) {
    const others = mine.map((t) => (t.ids[0] === id ? t.ids[1] : t.ids[0]))
    out.push({
      kind: 'touch',
      text: others.length === 1 ? `Touches ${nameOf(others[0]!)}, so they will print as one piece` : `Touches ${others.length} other objects, so they will print as one piece`,
      which: mine.map((t, i) => `${nameOf(others[i]!)}, ${t.gapMm < 0.005 ? 'touching' : `${mm(t.gapMm)} apart`}`),
      others,
    })
  }
  if (!fit) return out
  const part = (k: number) => fit.names[k] ?? `part ${k + 1}`
  const loose = fit.gaps.filter((g) => g.kind === 'apart')
  if (loose.length) {
    const g = loose[0]!
    out.push({
      kind: 'apart',
      text: loose.length === 1 ? `${part(g.parts[0])} and ${part(g.parts[1])} are ${mm(g.gapMm)} apart and do not touch, so they print as separate pieces` : `${loose.length} pairs of parts are close but do not touch, so they print as separate pieces`,
      which: loose.map((l) => `${part(l.parts[0])} and ${part(l.parts[1])}, ${mm(l.gapMm)}`),
    })
  }
  const side = fit.gaps.filter((g) => g.kind === 'horizontal')
  if (side.length) {
    out.push({
      kind: 'horizontal',
      text: `${count(side.length, 'gap is', 'gaps are')} under the ${mm(fit.limitMm)} this printer keeps open, so those parts may fuse`,
      which: side.map((g) => `${part(g.parts[0])} and ${part(g.parts[1])}, ${mm(g.gapMm)}`),
    })
  }
  const up = fit.gaps.filter((g) => g.kind === 'vertical')
  if (up.length) {
    const smallest = Math.min(...up.map((g) => g.gapMm))
    out.push({
      kind: 'vertical',
      text: `${count(up.length, 'gap', 'gaps')} over a part ${up.length === 1 ? 'is' : 'are'} thinner than a ${mm(layerHeightMm)} layer and will close`,
      which: up.map((g) => `${part(g.parts[0])} and ${part(g.parts[1])}, ${mm(g.gapMm)}`),
      layerMm: Math.max(0.08, Math.floor(Math.min(layerHeightMm, smallest) * 100) / 100),
    })
  }
  return out
}
