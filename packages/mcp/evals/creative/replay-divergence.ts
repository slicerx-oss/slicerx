// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Checks a replay against its recording. A recording that keeps what the model read (`seen`: the tool results in front
// of it for each reply) lets the replay compare the results it gets with those, request by request. The first time they
// differ in a way that matters, the replay says so by name, so a recording gone stale surfaces as "replay diverged at
// request N" and not later as a part that was never built or a part that is gone. Used by both replay harnesses (the
// creative eval's run.ts and the mimir build eval's drive.ts). Test code only.
import type { LlmMessage } from '@slicerx/pilot'
import type { ScriptStepData } from '@slicerx/pilot/evals'

/** A recorded reply, with the tool results the model had just read when it wrote it (absent in older recordings). */
export interface RecordedStep extends ScriptStepData {
  seen?: string[]
}

// ids the app makes from the time and a counter: designs and objects (obj_...), plans (plan_...), volumes and plates,
// steps (s...) and dimensions (d...). A step or dimension id in running text needs a digit, so a long word is not
// read as one; as the value of an id, sketch or step field it needs none, since the time and counter in base 36 can
// be all letters, and a sketch id missed there kept the recording's id in the next call. They change every run, so they
// never count.
export const MADE_ID = /\b(?:obj|plan|vol|plate)_[0-9a-z~]+\b|\b[sd](?=[0-9a-z]*\d)[0-9a-z]{9,}\b|(?<="(?:id|sketch|step)":")[sd][0-9a-z]{9,}(?=")/g

/** The tool results after the last assistant message: what the model read just before this reply. */
export function toolResultsSeen(messages: readonly LlmMessage[]): string[] {
  let k = messages.length
  while (k > 0 && messages[k - 1]!.role !== 'assistant') k--
  return messages.slice(k).flatMap((m) => (m.role === 'tool' ? [m.content] : []))
}

/** The tool names of the last assistant message's calls, by call id, for naming the tool a result came from. */
function toolNames(messages: readonly LlmMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (let k = messages.length - 1; k >= 0; k--) {
    const m = messages[k]!
    if (m.role !== 'assistant') continue
    for (const c of m.toolCalls ?? []) names.set(c.id, c.name)
    break
  }
  return names
}

/**
 * The parts of a tool result that say what happened: whether it went through, its summary or error (with the notes a
 * summary carries, such as where a part landed), a refusal's code, the issues listed, and the step and part counts of a
 * design. Made ids are blanked and nothing else is dropped from the words, so a moved coordinate counts. Anything that
 * is not the tool result shape compares as its text.
 */
export interface Fingerprint {
  ok?: boolean
  message: string
  code?: string
  issues?: string
  steps?: number
  parts?: number
}

const blank = (s: string): string => s.replace(MADE_ID, '<id>')
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function fingerprint(content: string): Fingerprint {
  let v: unknown
  try {
    v = JSON.parse(content)
  } catch {
    return { message: blank(content) }
  }
  if (!isObj(v)) return { message: blank(content) }
  const text = typeof v['summary'] === 'string' ? v['summary'] : typeof v['error'] === 'string' ? v['error'] : ''
  const f: Fingerprint = { message: blank(text) }
  if (typeof v['ok'] === 'boolean') f.ok = v['ok']
  if (typeof v['code'] === 'string') f.code = v['code']
  if (Array.isArray(v['issues'])) f.issues = blank(v['issues'].map(String).join('; '))
  const r = v['result']
  if (isObj(r)) {
    if (typeof r['steps'] === 'number') f.steps = r['steps']
    if (Array.isArray(r['parts'])) f.parts = r['parts'].length
  }
  return f
}

/**
 * Whether a tool's success wording is advice, not a change to the design: reads, checks, lookups, cards and every tool
 * that is not a design or geom one. The words of a design.check or a lookup change when the tool's wording does, and a
 * recording stays good for it, so for these only the ok or error, a refusal's code and the issues listed count. A design
 * or geom tool that changes the design has its summary (what it did, where the part landed) compared word for word.
 */
const READS = /^(?:design\.(?:plan|check|list|steps|timeline|put_plan)|geom\.(?:info|faces|face_pick|edge_pick|measure|sketch_check|sketch_edit|sketch_solve))$/
const advisory = (tool: string): boolean => !/^(?:geom|design)\./.test(tool) || READS.test(tool)

/** Whether one failure message is the other with more said after it: a tool that adds advice to an error it already gave. */
const extended = (a: string, b: string): boolean => {
  const [x, y] = [a, b].map((t) => t.replace(/[.\s]+$/, ''))
  return x!.startsWith(y!) || y!.startsWith(x!)
}

const CLIP = 140

/** `text` cut to a window around position `at`, so the part that differs is the part shown. */
function around(text: string, at: number): string {
  const from = Math.max(0, at - 30)
  const cut = text.slice(from, from + CLIP)
  return `${from > 0 ? '...' : ''}${cut}${from + CLIP < text.length ? '...' : ''}`
}

const word = (f: Fingerprint): string => (f.ok === undefined ? 'a result' : f.ok ? 'ok' : 'failed')

/** What differs between two results that matters, said short for each side; undefined when they match. */
export function differs(recorded: string, got: string, tool = ''): { recorded: string; got: string } | undefined {
  const a = fingerprint(recorded)
  const b = fingerprint(got)
  if (a.ok !== b.ok) return { recorded: `${word(a)} "${around(a.message, 0)}"`, got: `${word(b)} "${around(b.message, 0)}"` }
  // an advice tool that went through says it in words that may change; one that failed says why, and that counts
  if (a.message !== b.message && !(a.ok !== false && advisory(tool)) && !(a.ok === false && extended(a.message, b.message))) {
    let i = 0
    while (i < a.message.length && a.message[i] === b.message[i]) i++
    return { recorded: `${word(a)} "${around(a.message, i)}"`, got: `${word(b)} "${around(b.message, i)}"` }
  }
  for (const k of ['code', 'issues', 'steps', 'parts'] as const) if (a[k] !== b[k]) return { recorded: `${k} ${a[k] === undefined ? 'none' : String(a[k])}`, got: `${k} ${b[k] === undefined ? 'none' : String(b[k])}` }
  return undefined
}

/**
 * Compares the results a replay's model is about to read with the ones its recording saw at this request, in order.
 * `request` is the 1-based position of the reply in the recording. Returns the failure message for the first result
 * that differs, undefined when they all match. A recording without `seen` for this reply is not checked.
 */
export function divergence(request: number, seen: readonly string[] | undefined, messages: readonly LlmMessage[]): string | undefined {
  if (!seen?.length) return undefined
  const got = toolResultsSeen(messages)
  const names = toolNames(messages)
  const tools = messages.flatMap((m) => (m.role === 'tool' ? [names.get(m.callId) ?? 'a tool'] : [])).slice(-got.length)
  const say = (tool: string, recorded: string, was: string): string => `replay diverged at request ${request} (${tool}): recorded ${recorded}, got ${was}`
  for (let i = 0; i < Math.min(seen.length, got.length); i++) {
    const d = differs(seen[i]!, got[i]!, tools[i])
    if (d) return say(tools[i] ?? 'a tool', d.recorded, d.got)
  }
  if (seen.length !== got.length) return say(tools[got.length - 1] ?? 'a tool', `${seen.length} tool result${seen.length === 1 ? '' : 's'}`, `${got.length}`)
  return undefined
}

/**
 * One replay's check. `step(i, seen, messages)` runs as each recorded reply is about to be sent; the first difference
 * is kept in `diverged`, and from then on it says so again, so the caller can end the replay on it instead of feeding the
 * model results it never saw.
 */
export interface ReplayCheck {
  diverged?: string
  step(index: number, seen: readonly string[] | undefined, messages: readonly LlmMessage[]): string | undefined
}

export function createReplayCheck(): ReplayCheck {
  const check: ReplayCheck = {
    step(index, seen, messages) {
      const d = divergence(index + 1, seen, messages)
      if (check.diverged === undefined && d !== undefined) check.diverged = d
      return check.diverged
    },
  }
  return check
}

/**
 * For a replay: checks each request a scripted client would answer from its recording (not a web lookup, nor the closing
 * message after a denial) against the tool results that recording kept for it. Returns the failure message once a
 * request differs, and the same message for every request after it, so the caller can reply with it and end the replay.
 */
export function replayRequests(steps: readonly RecordedStep[], check: ReplayCheck): (req: { messages: readonly LlmMessage[]; webSearch?: boolean; toolChoice?: string }) => string | undefined {
  let index = 0
  return (req) => {
    if (req.webSearch || req.toolChoice === 'none') return undefined
    return check.step(index, steps[index++]?.seen, req.messages)
  }
}
