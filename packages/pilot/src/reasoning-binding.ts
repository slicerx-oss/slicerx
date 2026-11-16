// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Signed reasoning is bound to the request it came from: the system prompt and the tools. When a later request changes
// either, the provider refuses that reasoning and every block signed after it. So each assistant message with signed
// reasoning records what it was signed against, and reasoning leaves the history once the request it would go back in
// differs. It leaves from the oldest end and never comes back, the only removal the provider accepts. Nothing else the
// request sets moves it: not the tier, the effort, the thinking settings or the output limit, and not the model. A
// request to another model is still taken: the provider sets aside, unbilled, any reasoning the answering model cannot
// read, and the model reads the rest; taking it out here would lose it for the way back. So a run that moves up to
// muninn, on the same model or another, keeps the chat's reasoning and its cached history. When the system prompt or
// tools change, as when pilot.load_tools brings in another toolset on a capped chat or a follow-up's line joins the
// system prompt, the provider refuses it, so it leaves. With adaptive thinking the provider takes a tool loop whose
// newest step has no reasoning, and the model goes on without it.
import type { LlmMessage, LlmToolDef } from './provider/types'

const SIGNED = new Set(['thinking', 'redacted_thinking'])

function signedBlock(b: unknown): boolean {
  return typeof b === 'object' && b !== null && SIGNED.has(String((b as { type?: unknown }).type))
}

/** Two 32-bit FNV-1a hashes of a string with different seeds, as hex: a key, not a secret. */
function fnv(s: string): string {
  let a = 0x811c9dc5
  let b = 0x050c5d1f
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x01000193)
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0')
}

/** What a request binds the reasoning it gets back to: a hash of its system prompt and tools. */
export function bindingKey(messages: readonly LlmMessage[], tools: readonly LlmToolDef[]): string {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content)
  return fnv(JSON.stringify([system, tools.map((t) => [t.name, t.description, t.parameters])]))
}

/**
 * Takes signed reasoning out of the messages when a request bound by `key` would carry reasoning bound to something
 * else: from the newest such message back to the start of the chat, so what stays is an unbroken run up to the present.
 * Only another system prompt or tool list counts, before `runStart` and in the run in progress alike; `runStart` is
 * kept for callers. Returns how many messages lost reasoning.
 */
export function unbindOldReasoning(messages: LlmMessage[], _runStart: number, key: string): number {
  let last = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'assistant' || !m.raw?.some(signedBlock)) continue
    const other = m.bound !== key
    if (other) {
      last = i
      break
    }
  }
  let changed = 0
  for (let i = 0; i <= last; i++) {
    const m = messages[i]
    if (m?.role !== 'assistant' || !m.raw?.some(signedBlock)) continue
    const rest = m.raw.filter((b) => !signedBlock(b))
    const { raw: _raw, bound: _bound, ...plain } = m
    messages[i] = rest.length > 0 ? { ...plain, raw: rest } : plain
    changed++
  }
  return changed
}
