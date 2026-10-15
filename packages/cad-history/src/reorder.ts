// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { followField, followsOf, type History, type ReplayResult, type Step } from './model'

/** Move a feature, retaining placement when its end-face reference would now point forward. */
export function movedSteps(steps: readonly Step[], from: number, to: number): Step[] {
  const out = [...steps]
  const [step] = out.splice(from, 1)
  if (!step) return [...steps]
  out.splice(Math.max(0, Math.min(to, out.length)), 0, step)
  return out.map((s, i) => {
    const keep = followsOf(s).filter((f) => out.findIndex((p) => p.id === f.step) < i)
    if (keep.length === followsOf(s).length) return s
    const { follow: _f, ...rest } = s
    return { ...rest, ...followField(keep) }
  })
}

const creates = (s: Step): boolean => (s.params.op === 'shape.extrude' && (s.params.spec.operation ?? 'new') === 'new') || (s.params.op === 'sketch.revolve' && (s.params.operation ?? 'new') === 'new')

/** Part identities after a feature; a split keeps its first piece at the target's identity. */
function after(s: Step, parts: readonly string[], splitCount = 1): string[] {
  const out = [...parts]
  if (s.suppressed) return out
  const p = s.params
  if (creates(s)) {
    if (s.part < out.length) out[s.part] = `${s.id}:body`
    else out.push(`${s.id}:body`)
  } else if (p.op === 'parts.add') out.push(...p.parts.map((_, i) => `${s.id}:add:${i}`))
  else if (p.op === 'boolean') return out.filter((_, i) => !p.with.includes(i))
  else if (p.op === 'plane.cut' && p.keep === 'both') out.splice(s.part + 1, 0, `${s.id}:top`)
  else if (p.op === 'split') out.splice(s.part + 1, 0, ...Array.from({ length: Math.max(0, splitCount - 1) }, (_, i) => `${s.id}:piece:${i + 1}`))
  return out
}

/**
 * Reorder with part references kept on the same bodies. Creation and removal change numeric part
 * indexes; split counts come from replay, including when the reordered geometry splits differently.
 */
export async function reorderedSteps(history: History, from: number, to: number, replay: (history: History) => Promise<ReplayResult>): Promise<Step[]> {
  if (from === to) return [...history.steps]
  const ordered = movedSteps(history.steps, from, to)
  const base = history.base.map((_, i) => `base:${i}`)
  const refs = new Map<string, { target?: string; others: string[]; append: boolean; splitCount: number }>()
  let parts = base
  for (const [i, s] of history.steps.entries()) {
    let splitCount = 1
    if (s.params.op === 'split' && !s.suppressed) {
      const r = await replay({ ...history, steps: history.steps.slice(0, i + 1) })
      if (r.status[i]?.state === 'done') splitCount = Math.max(1, r.parts.length - parts.length + 1)
    }
    const target = parts[s.part]
    refs.set(s.id, { ...(target === undefined ? {} : { target }), others: s.params.op === 'boolean' ? s.params.with.map((n) => parts[n] ?? `missing:${n}`) : [], append: creates(s) && s.part >= parts.length, splitCount })
    parts = after(s, parts, splitCount)
  }
  parts = base
  const result: Step[] = []
  for (const s of ordered) {
    const ref = refs.get(s.id)!
    const index = (id: string | undefined): number => {
      const i = id === undefined ? -1 : parts.indexOf(id)
      if (i < 0) throw new Error(`The part used by feature ${s.id} does not exist at its new position. Move its creating feature before it.`)
      return i
    }
    // Suppressed features still need the right references when turned back on.
    const part = s.part === -1 || s.params.op === 'parts.add' ? s.part : ref.append ? parts.length : index(ref.target)
    const params = s.params.op === 'boolean' ? { ...s.params, with: ref.others.map(index) } : s.params
    const next = part === s.part && params === s.params ? s : { ...s, part, params }
    result.push(next)
    let splitCount = ref.splitCount
    if (s.params.op === 'split' && !s.suppressed) {
      const r = await replay({ ...history, steps: result })
      if (r.status[result.length - 1]?.state === 'done') splitCount = Math.max(1, r.parts.length - parts.length + 1)
    }
    parts = after(next, parts, splitCount)
  }
  return result
}
