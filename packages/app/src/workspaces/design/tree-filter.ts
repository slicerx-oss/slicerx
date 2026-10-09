// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model tree's filter: typed in the tree, it keeps the objects whose names match with all their steps, and the
// objects with matching steps showing only those. A few words find a kind: "broken", "off" (suppressed), "mesh" and
// "sketch".
import { stepName, type Step } from '../../cad/history/model'
import { stepSketch } from '../../cad/history/step-icon'

export interface Filterable {
  id: string
  name: string
  history?: { steps: readonly Step[] } | undefined
}

/** What a row shows under the filter: hidden, every step, or only these steps (which also opens the object). */
export type Shown = { show: false } | { show: true; steps: ReadonlySet<number> | null }

function stepMatches(s: Step, q: string): boolean {
  if (q === 'broken' && s.broken !== undefined) return true
  if (q === 'off' && s.suppressed) return true
  if (q === 'sketch' && stepSketch(s.params) !== null) return true
  return stepName(s).toLowerCase().includes(q)
}

/** Each object's row under the filter. An empty filter shows everything. */
export function filterTree(objects: readonly Filterable[], query: string): Map<string, Shown> {
  const q = query.trim().toLowerCase()
  const out = new Map<string, Shown>()
  for (const o of objects) {
    if (!q || o.name.toLowerCase().includes(q) || (q === 'mesh' && !o.history)) {
      out.set(o.id, { show: true, steps: null })
      continue
    }
    const steps = new Set((o.history?.steps ?? []).flatMap((s, i) => (stepMatches(s, q) ? [i] : [])))
    out.set(o.id, steps.size ? { show: true, steps } : { show: false })
  }
  return out
}

/** A printable key typed in the tree starts the filter: one character, no Cmd, Ctrl or Alt. */
export function startsFilter(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  return e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey
}
