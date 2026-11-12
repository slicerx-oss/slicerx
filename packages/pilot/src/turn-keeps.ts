// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a follow-up keeps. A follow-up changes the design the person asked about and leaves the rest as it was: a run
// that took away a built feature the person did not ask to remove (undone, turned off or broken), or built one again
// beside the old one, goes back to fix that while it still can, before its reply. A reply may still end without it
// when its first line names what is missing and why. The steps come from design.steps at the start of the run and
// when it would end; a feature is a step's plan feature, or its name when it has none.
// The measured-change note never scales an amount the person gave or a small one they asked for.

/** One step as design.steps lists it. */
export interface KeptRow {
  id: string
  name: string
  op: string
  feature?: string
  state: string
}

/** The steps a design.steps answer lists, or null when it is not one. */
export function keptRows(message: string): KeptRow[] | null {
  try {
    const o = JSON.parse(message) as { ok?: boolean; result?: { steps?: unknown } }
    const steps = o.result?.steps
    if (o.ok === false || !Array.isArray(steps)) return null
    return steps.filter((s): s is KeptRow => typeof s === 'object' && s !== null && typeof (s as KeptRow).id === 'string' && typeof (s as KeptRow).name === 'string')
  } catch {
    return null
  }
}

const keyOf = (r: KeptRow): string => (r.feature?.trim() ? r.feature.trim() : r.name)
const live = (r: KeptRow): boolean => r.state === 'done'

const REMOVE = /\b(remove|removing|delete|take (?:off|out|away)|get rid of|drop|without|no more|lose|strip (?:off|away))\b/i
const words = (s: string): string[] => s.toLowerCase().match(/[a-z]{4,}/g) ?? []

/** Whether the request asks to remove the feature named `key`: a removal word and one of the feature's own words. */
export function askedToRemove(request: string, key: string): boolean {
  if (!REMOVE.test(request)) return false
  const asked = new Set(words(request).map((w) => w.replace(/s$/, '')))
  return words(key).some((w) => asked.has(w.replace(/s$/, '')))
}

export interface Lost {
  /** Features built before the run that no step makes now. */
  removed: string[]
  /** Features built again this run while the step that made them before still stands. */
  doubled: { feature: string; old: number; now: number }[]
}

/** What the run lost or doubled, against the steps at its start; null when it kept everything. */
export function lostFeatures(start: readonly KeptRow[], end: readonly KeptRow[], request: string): Lost | null {
  const was = new Set(start.filter(live).map(keyOf))
  const now = new Set(end.filter(live).map(keyOf))
  const removed = [...was].filter((k) => !now.has(k) && !askedToRemove(request, k))
  const before = new Set(start.map((r) => r.id))
  const doubled: Lost['doubled'] = []
  for (const [j, r] of end.entries()) {
    if (before.has(r.id) || !live(r)) continue
    const old = end.findIndex((o) => before.has(o.id) && live(o) && o.op === r.op && keyOf(o) === keyOf(r))
    if (old >= 0 && !doubled.some((d) => d.feature === keyOf(r))) doubled.push({ feature: keyOf(r), old: old + 1, now: j + 1 })
  }
  return removed.length || doubled.length ? { removed, doubled } : null
}

/** Whether the reply's first line names every feature it lost and every one it doubled. */
export function firstLineNames(reply: string, lost: Lost): boolean {
  const first = (reply.split('\n').find((l) => l.trim()) ?? '').toLowerCase()
  return [...lost.removed, ...lost.doubled.map((d) => d.feature)].every((k) => first.includes(k.toLowerCase()))
}

/** The note sent back when a run would end with features lost or doubled. */
export function keepsNote(lost: Lost): string {
  const parts: string[] = []
  if (lost.removed.length) parts.push(`this turn took away ${lost.removed.join(', ')}, which the person did not ask to remove: design.steps no longer shows a step making ${lost.removed.length === 1 ? 'it' : 'them'}. Build ${lost.removed.length === 1 ? 'it' : 'them'} back now as before, with the colors and paint ${lost.removed.length === 1 ? 'it' : 'they'} had`)
  for (const d of lost.doubled) parts.push(`step ${d.old} still makes ${d.feature} beside step ${d.now}, which made it again: turn the old one off with design.edit_step suppressed, or remove the new one`)
  return `Before you answer: ${parts.join('; and ')}. If one cannot come back, the reply's first line names what is missing and why.`
}

/** What the chat says when a run ends with features still lost or doubled after its notes. */
export function keepsNotice(lost: Lost): string {
  const out: string[] = []
  if (lost.removed.length) out.push(`Missing after this change: ${lost.removed.join(', ')}.`)
  for (const d of lost.doubled) out.push(`${d.feature} is there twice (steps ${d.old} and ${d.now}).`)
  return out.join(' ')
}

const AMOUNT = /\b\d+(?:\.\d+)?\s*(?:mm|cm|in|inch(?:es)?|deg(?:rees?)?|°|%|percent|times)(?![a-z])|\b(?:a little|a bit|a touch|a tad|slightly|somewhat|just a)\b/i

/** Whether the request gives the amount of its change, or asks for a small one: the change keeps that amount. */
export function statesAmount(request: string): boolean {
  return AMOUNT.test(request)
}

/** The note for a change under the floor when the person gave its amount: it stays, and the reply says it is subtle. */
export const keptAmountNote = (pct: number, floor: number): string =>
  `Measured: the change so far moved ${pct}% of the whole-model view, under the ${floor}% a person sees at that view. The person gave the amount, so keep it as asked: do not make it larger. If it is done, answer, say the change is subtle at the whole-model view, and offer a larger one.`
