// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Keep a conversation inside a local model's context. Ollama cuts the start of a prompt that is
// too long, which is the system prompt, and says so only in its log. So before each request the
// oldest earlier turns go first, then the oldest tool results of the current run shrink to a
// stub, then the newest results are shortened in the middle. The system prompt, the current
// request and the start and end of the newest results always stay.
import type { LlmMessage, LlmToolDef } from './provider/types'

/**
 * The context mimir needs from a local model, in tokens. Its system prompt and tool schemas
 * measured 12,845 to 14,175 tokens in our local model benchmark.
 * Ollama and LM Studio load a model with 4096 unless told otherwise.
 */
export const MIMIR_CONTEXT = 16384

/** Room left for the model's reply. */
export const REPLY_RESERVE = 1024

/** Tool results of the current run that always keep their full text. */
const KEEP_RESULTS = 2

/** The most a kept tool result may cost once even the newest results do not fit. */
const RESULT_CAP = 1500

export const TRIMMED_TURNS = '(Earlier conversation left out to fit the model.)'
export const TRIMMED_RESULT = '{"ok":true,"summary":"(Result left out to fit the model. Run the tool again if it is needed.)"}'
export const SHORTENED = '\n(The middle of this result was left out to fit the model.)\n'

/**
 * Tokens a text costs. Measured against Ollama's own count for qwen2.5 on mimir's requests: tool
 * results (JSON with numbers) run 3.1 to 3.7 characters a token and the system prompt and tool
 * schemas about 4.6, so these rates estimate a little high, which is the safe side.
 */
export function estimateTokens(text: string, charsPerToken = 3.5): number {
  return Math.ceil(text.length / charsPerToken)
}

/** A rough cost for one image; local runners mostly drop images, so this only keeps room. */
const IMAGE_TOKENS = 800

export function messageTokens(m: LlmMessage): number {
  let n = 4 + estimateTokens(m.content)
  if (m.role === 'assistant' && m.toolCalls) for (const c of m.toolCalls) n += estimateTokens(c.name) + estimateTokens(c.arguments) + 8
  if (m.role === 'tool' && m.images) n += m.images.length * IMAGE_TOKENS
  return n
}

export function toolsTokens(tools: readonly LlmToolDef[]): number {
  return tools.reduce((a, t) => a + estimateTokens(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }), 4.5) + 8, 0)
}

const total = (ms: readonly LlmMessage[]): number => ms.reduce((a, m) => a + messageTokens(m), 0)

/**
 * The messages to send so that they and the tools fit `contextTokens` with REPLY_RESERVE to spare.
 * Returns `messages` itself when they fit, otherwise a trimmed copy; `messages` is never changed,
 * so the full history stays for the next turn and for the person reading it.
 */
export function fitContext(messages: readonly LlmMessage[], tools: readonly LlmToolDef[], contextTokens: number): { messages: readonly LlmMessage[]; droppedTurns: number; stubbedResults: number; shortenedResults: number } {
  const budget = contextTokens - REPLY_RESERVE - toolsTokens(tools)
  if (total(messages) <= budget) return { messages, droppedTurns: 0, stubbedResults: 0, shortenedResults: 0 }

  const system = messages[0]?.role === 'system' ? [messages[0]] : []
  const rest = messages.slice(system.length)
  // The current request starts at the last user message; everything before it is earlier turns.
  let current = rest.length - 1
  while (current > 0 && rest[current]?.role !== 'user') current--
  const turnStarts: number[] = []
  for (let i = 0; i < current; i++) if (rest[i]?.role === 'user') turnStarts.push(i)

  // 1. Drop the oldest earlier turns, a whole turn at a time, until the rest fits.
  let from = 0
  let droppedTurns = 0
  const fixed = total(system)
  while (from < current && fixed + total(rest.slice(from)) > budget) {
    from = turnStarts.find((s) => s > from) ?? current
    droppedTurns++
  }
  const kept = rest.slice(from).map((m) => m)
  if (droppedTurns && kept[0]?.role === 'user') kept[0] = { role: 'user', content: `${TRIMMED_TURNS}\n\n${kept[0].content}` }

  // 2. Still too long: shrink the oldest tool results of the current run, keeping the newest ones.
  let stubbedResults = 0
  const results = kept.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0)
  for (const i of results.slice(0, Math.max(0, results.length - KEEP_RESULTS))) {
    if (fixed + total(kept) <= budget) break
    const m = kept[i]
    if (m?.role !== 'tool' || m.content === TRIMMED_RESULT) continue
    kept[i] = { role: 'tool', callId: m.callId, content: TRIMMED_RESULT }
    stubbedResults++
  }

  // 3. Still too long: cut the middle out of the newest results, oldest first, down to RESULT_CAP
  // and then to whatever room is left, keeping the start and the end where summaries sit.
  let shortenedResults = 0
  for (const i of results.slice(-KEEP_RESULTS)) {
    const over = fixed + total(kept) - budget
    if (over <= 0) break
    const m = kept[i]
    if (m?.role !== 'tool') continue
    const cost = estimateTokens(m.content)
    const target = Math.max(200, Math.min(RESULT_CAP, cost - over))
    if (cost <= target) continue
    const chars = Math.floor(target * 3.5) - SHORTENED.length
    const head = Math.ceil(chars * 0.6)
    kept[i] = { role: 'tool', callId: m.callId, content: `${m.content.slice(0, head)}${SHORTENED}${m.content.slice(m.content.length - (chars - head))}`, ...(m.images ? { images: m.images } : {}) }
    shortenedResults++
  }
  return { messages: [...system, ...kept], droppedTurns, stubbedResults, shortenedResults }
}
