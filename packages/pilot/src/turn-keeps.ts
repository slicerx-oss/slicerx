// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a follow-up keeps. A follow-up changes the design the person asked about and leaves the rest as it was: a run
// that took away a built feature the person did not ask to remove (undone, turned off or broken) goes back to build
// it again while it still can, before its reply. A reply may still end without it
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
}

/**
 * What the run lost, against the steps at its start; null when it kept everything. A feature built again while the
 * step that made it before still stands is not counted: a second piece of one planned feature (another tier, another
 * row) is a normal change, and telling it from a copy left behind needs where each step's shape stands.
 */
export function lostFeatures(start: readonly KeptRow[], end: readonly KeptRow[], request: string): Lost | null {
  const was = new Set(start.filter(live).map(keyOf))
  const now = new Set(end.filter(live).map(keyOf))
  const removed = [...was].filter((k) => !now.has(k) && !askedToRemove(request, k))
  return removed.length ? { removed } : null
}

/** Whether the reply's first line names every feature it lost. */
export function firstLineNames(reply: string, lost: Lost): boolean {
  const first = (reply.split('\n').find((l) => l.trim()) ?? '').toLowerCase()
  return lost.removed.every((k) => first.includes(k.toLowerCase()))
}

/** The note sent back when a run would end with features lost. */
export function keepsNote(lost: Lost): string {
  const parts: string[] = []
  parts.push(`this turn took away ${lost.removed.join(', ')}, which the person did not ask to remove: design.steps no longer shows a step making ${lost.removed.length === 1 ? 'it' : 'them'}. Build ${lost.removed.length === 1 ? 'it' : 'them'} back now as before, with the colors and paint ${lost.removed.length === 1 ? 'it' : 'they'} had`)
  return `Before you answer: ${parts.join('; and ')}. If one cannot come back, the reply's first line names what is missing and why.`
}

/** What the chat says when a run ends with features still lost after its notes. */
export function keepsNotice(lost: Lost): string {
  return `Missing after this change: ${lost.removed.join(', ')}.`
}

const AMOUNT = /\b\d+(?:\.\d+)?\s*(?:mm|cm|in|inch(?:es)?|deg(?:rees?)?|°|%|percent|times)(?![a-z])|\b(?:a little|a bit|a touch|a tad|slightly|somewhat|just a)\b/i

/** Whether the request gives the amount of its change, or asks for a small one: the change keeps that amount. */
export function statesAmount(request: string): boolean {
  return AMOUNT.test(request)
}

/** The note for a change under the floor when the person gave its amount: it stays, and the reply says it is subtle. */
export const keptAmountNote = (pct: number, floor: number): string =>
  `Measured: the change so far moved ${pct}% of the whole-model view, under the ${floor}% a person sees at that view. The person gave the amount, so keep it as asked: do not make it larger. If it is done, answer, say the change is subtle at the whole-model view, and offer a larger one.`
