// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How a replay numbers the parts its steps name (docs/cad-history.md, "Part numbers"). Replay and anything that follows
// the parts through a history without the engine (the MCP part form lines) read the numbers through this one module, so
// they cannot drift apart.
import type { Step, StepParams } from './model'

/** Whether the step makes a new body (a new part) rather than working on one. */
export function makesBody(p: StepParams): boolean {
  return (p.op === 'shape.extrude' && (p.spec.operation ?? 'new') === 'new') || ((p.op === 'sketch.revolve' || p.op === 'sketch.loft' || p.op === 'sketch.sweep') && (p.operation ?? 'new') === 'new')
}

/** A new body at `at`, the part count when its step was made: added after the last part, or made again in place. */
export function placeBody<T>(parts: T[], at: number, body: T): void {
  if (at < parts.length) parts[at] = body
  else parts.push(body)
}

/**
 * The parts as a replay holds them between steps. The first `numbered` are the parts the history numbers as it was
 * made. The rest are parts a turned-off step would have taken away: they stay in the design, after the numbered parts.
 */
export interface Numbering<T> {
  parts: T[]
  numbered: number
}

/** All parts numbered, as before any step that takes parts away is turned off. */
export const numbering = <T>(parts: T[]): Numbering<T> => ({ parts, numbered: parts.length })

/**
 * A turned-off step still numbers the parts as if it had run. A boolean takes its `with` parts away; turned off, those
 * parts stay in the design, moved to the end of the list after the numbered parts, so every later step finds its part
 * at the number it was made with and nothing is lost. A boolean whose parts are not all there is left as it is (when
 * on, it would break). Other steps change no part numbers here.
 */
export function turnedOff<T>(s: Step, at: Numbering<T>): Numbering<T> {
  const p = s.params
  if (p.op !== 'boolean' || !p.with.length) return at
  const { parts, numbered } = at
  const real = (i: number) => Number.isInteger(i) && i >= 0 && i < parts.length
  if (!real(s.part) || !p.with.every(real) || p.with.includes(s.part)) return at
  const away = [...new Set(p.with)].sort((a, b) => a - b)
  return {
    parts: [...parts.filter((_, i) => !away.includes(i)), ...away.map((i) => parts[i]!)],
    numbered: numbered - away.filter((i) => i < numbered).length,
  }
}

/** The part numbers a step names: its own part and, for a boolean, the parts it takes in. None for a step on every part. */
const named = (s: Step): number[] => (s.part === -1 ? [] : [s.part, ...(s.params.op === 'boolean' ? s.params.with : [])])

/**
 * The parts a step runs on, and the parts after it from what it made of them.
 *
 * With every part numbered the step runs on them all, as always. Once a turned-off step has set parts aside, a step
 * made while that step ran (every part it names numbered, a new body at the numbered count, an order of the numbered
 * parts) runs on the numbered parts alone, and the parts set aside stay after them. A step made after the turn-off
 * names parts as they were shown then, set-aside ones among them, so it runs on every part, and the numbered count
 * follows the numbered parts it took away. A new order of every part numbers them all again. Added parts name no
 * number and go after every part, where the app puts a part it adds (a clone, a merged object) with no replay, so a
 * part never moves when the design is replayed or opened again.
 */
export function stepParts<T>(s: Step, at: Numbering<T>): { parts: T[]; after: (out: T[]) => Numbering<T> } {
  const { parts, numbered } = at
  const all = { parts, after: (out: T[]) => numbering(out) }
  if (numbered >= parts.length) return all
  const p = s.params
  const own = { parts: parts.slice(0, numbered), after: (out: T[]) => ({ parts: [...out, ...parts.slice(numbered)], numbered: out.length }) }
  if (s.part === -1) {
    if (p.op === 'parts.order') return p.order.length === numbered ? own : all
    return { parts, after: (out) => ({ parts: out, numbered }) }
  }
  if (makesBody(p) ? s.part <= numbered : named(s).every((i) => i < numbered)) return own
  const gone = p.op === 'boolean' ? new Set(p.with.filter((i) => i < numbered)).size : 0
  return { parts, after: (out) => ({ parts: out, numbered: numbered - gone }) }
}
