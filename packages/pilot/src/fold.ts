// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a cloud request carries of the chat's earlier turns. The turn in progress goes in whole, so the model has every
// result it reads while it works. Each tool result from an earlier turn goes as one line: the tool, how it went and the
// first sentence of its summary, with the ids it returned. A short result goes as it is. Pictures from earlier turns
// are not sent. Each result still answers its own tool call id, so the provider takes the history.
//
// Signed reasoning from earlier turns is not sent either once anything in them is shortened: a signature covers the
// conversation before it, so that reasoning no longer matches what it was signed against. Leaving it out from the
// front is the removal the provider accepts, and the turn in progress has its reasoning signed against the shortened
// history, so its own reasoning stays valid for the rest of the turn. The next turn shortens that turn in the same way.
// A chat whose earlier results are all short changes nothing and keeps its reasoning.
//
// The history itself is never changed: planLeft, lastDesign and the rest still read every result in full, and what the
// person sees and the saved session are unchanged. The fold is a pure function of the history and where the turn
// starts, so every request of one turn sends the same bytes for the earlier turns and reads them from the cache.
import { PLAN_SEED_NOTE } from './plan-left'
import type { LlmMessage } from './provider/types'

/** A result up to this many characters goes as it is: a line about it would be no shorter. */
export const FOLD_KEEP_CHARS = 300
/** The longest summary a folded line carries, in characters. */
const SUMMARY_CHARS = 200
/** What the runtime appends to a result whose picture it took out (runtime.ts dropOldImages); folding ignores it. */
const IMAGE_NOTE = '\n(Older image removed to save space.)'
/** The first folded line in a request ends with this, so the model knows what the short lines are. */
export const FOLD_NOTE = 'Results from earlier turns are one line each and their pictures are not sent; call the tool again for a full or current result.'

const SIGNED = new Set(['thinking', 'redacted_thinking'])
const ID_KEYS = ['design', 'planId', 'lookupId', 'preview'] as const

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const signed = (b: unknown): boolean => isObj(b) && SIGNED.has(String(b['type']))

function parsed(content: string): Obj | undefined {
  try {
    const v: unknown = JSON.parse(content)
    return isObj(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** A JSON string field read straight from the text, for a result cut short (runtime.ts toolMessage) that no longer parses. */
function field(content: string, key: string): string | undefined {
  const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(content)
  if (!m) return undefined
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return undefined
  }
}

/** The first sentence of a summary, cut at a word to at most SUMMARY_CHARS. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const end = /[.!?](?=\s|$)/.exec(flat)
  const s = end ? flat.slice(0, end.index) : flat
  if (s.length <= SUMMARY_CHARS) return s.replace(/[.:;,]$/, '')
  const cut = s.lastIndexOf(' ', SUMMARY_CHARS)
  return `${s.slice(0, cut > SUMMARY_CHARS / 2 ? cut : SUMMARY_CHARS).replace(/[.:;,]$/, '')}...`
}

/** The ids a result returned that later calls name: its design, plan, lookup and preview. */
function idsOf(result: unknown, said: string): string[] {
  const r = isObj(result) && result['untrusted'] === true && isObj(result['data']) ? result['data'] : result
  if (!isObj(r)) return []
  const out: string[] = []
  for (const k of ID_KEYS) {
    const v = r[k]
    const id = typeof v === 'string' ? v : isObj(v) && typeof v['design'] === 'string' ? v['design'] : undefined
    if (id && !said.includes(id)) out.push(`${k === 'planId' ? 'plan' : k === 'lookupId' ? 'lookup' : k} ${id}`)
  }
  return out
}

/** The one line an earlier turn's result goes as: the tool, how it went, the first sentence of its summary, its ids. */
export function foldedLine(tool: string, content: string): string {
  const body = parsed(content)
  const ok = body ? body['ok'] !== false : !/^\{"ok":false/.test(content)
  const summary = body ? (typeof body['summary'] === 'string' ? body['summary'] : typeof body['error'] === 'string' ? body['error'] : typeof body['message'] === 'string' ? body['message'] : '') : (field(content, 'summary') ?? field(content, 'error') ?? (content.startsWith('{') ? '' : content))
  const said = firstSentence(summary)
  const ids = body ? idsOf(body['result'], said) : []
  const parts = [`${tool}, earlier turn (shortened): ${ok ? 'done' : 'failed'}${said ? `: ${said}` : ''}.`]
  if (ids.length) parts.push(`${ids.join(', ')}.`)
  return parts.join(' ')
}

/** Where the chat's own turns start: after a plan read back from the project (planSeed), which stays as it is. */
function firstTurn(messages: readonly LlmMessage[]): number {
  const i = messages.findIndex((m) => m.role === 'user' && m.content !== PLAN_SEED_NOTE)
  return i < 0 ? messages.length : i
}

/**
 * The messages a cloud request sends for a turn that started at `runStart` (the message after the turn's opening
 * request): the earlier turns folded as above, everything from `runStart - 1` on as it is. When the fold changes any
 * earlier result, every signed reasoning block before the turn leaves with it (from the oldest end, the removal the
 * provider accepts); when it changes none, the history goes as it is. Returns a new array; the messages it does not
 * change are the same objects.
 */
export function foldEarlierTurns(messages: readonly LlmMessage[], runStart: number): LlmMessage[] {
  const end = Math.min(runStart - 1, messages.length)
  const from = firstTurn(messages)
  if (end <= from) return [...messages]
  const names = new Map<string, string>()
  for (let i = 0; i < end; i++) {
    const m = messages[i]!
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) names.set(c.id, c.name)
  }
  let noted = false
  const out = messages.map((m, i): LlmMessage => {
    if (i < from || i >= end || m.role !== 'tool') return m
    const content = m.content.endsWith(IMAGE_NOTE) ? m.content.slice(0, -IMAGE_NOTE.length) : m.content
    if (content.length <= FOLD_KEEP_CHARS) return content === m.content && !m.images?.length ? m : { role: 'tool', callId: m.callId, content }
    const line = foldedLine(names.get(m.callId) ?? 'tool', content)
    const folded: LlmMessage = { role: 'tool', callId: m.callId, content: noted ? line : `${line} ${FOLD_NOTE}` }
    noted = true
    return folded
  })
  if (out.every((m, i) => m === messages[i])) return out
  for (let i = 0; i < end; i++) {
    const m = out[i]!
    if (m.role !== 'assistant' || !m.raw?.some(signed)) continue
    const rest = m.raw.filter((b) => !signed(b))
    const { raw: _raw, bound: _bound, ...plain } = m
    out[i] = rest.length > 0 ? { ...plain, raw: rest } : plain
  }
  return out
}
