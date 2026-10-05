// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A provider that replays a script instead of calling a model. Used by replay
// evals, tests and the demo. It behaves like a model that follows the script
// no matter what the tools return, which is what the adversarial cases need:
// a gullible model must still be stopped by the gate.
import type { LlmClient, LlmEvent, LlmMessage, LlmRequest } from './types'

export interface ScriptCall {
  name: string
  args: Record<string, unknown>
}

export interface ScriptStepData {
  reasoning?: string
  text?: string
  calls?: ScriptCall[]
}

export type ScriptStep = ScriptStepData | ((messages: LlmMessage[]) => ScriptStepData)

export interface ScriptedOptions {
  /** Reply used when the runtime asks for a closing message after a denial. */
  onStop?: string
  /** Split text into word chunks to exercise streaming. */
  chunk?: boolean
  provider?: string
  /** Pause per streamed chunk, ms, so demos stream like a model. 0 in tests. */
  delayMs?: number
  /** Pause before each tool call, ms. */
  callDelayMs?: number
}

const pause = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

function pieces(text: string, chunk: boolean): string[] {
  if (!chunk) return [text]
  return text.match(/\s*\S+/g) ?? [text]
}

export function createScriptedClient(steps: ScriptStep[], opts: ScriptedOptions = {}): LlmClient & { remaining(): number; requests: LlmRequest[] } {
  let i = 0
  let callSeq = 0
  const requests: LlmRequest[] = []
  const chunk = opts.chunk ?? true
  return {
    provider: opts.provider ?? 'scripted',
    requests,
    remaining: () => steps.length - i,
    async *stream(req: LlmRequest): AsyncIterable<LlmEvent> {
      requests.push(req)
      // Web lookups are separate requests with no function tools.
      if (req.webSearch) {
        yield { type: 'text', delta: 'Scripted web answer.' }
        yield { type: 'citation', url: 'https://example.com/scripted', title: 'Scripted source' }
        yield { type: 'done', stop: 'end' }
        return
      }
      if (req.toolChoice === 'none') {
        for (const p of pieces(opts.onStop ?? 'Stopped. Nothing was sent to a printer and no profile was changed.', chunk)) yield { type: 'text', delta: p }
        yield { type: 'usage', inputTokens: 200, outputTokens: 20 }
        yield { type: 'done', stop: 'end' }
        return
      }
      const raw = steps[i++]
      if (raw === undefined) {
        yield { type: 'done', stop: 'end' }
        return
      }
      const step = typeof raw === 'function' ? raw(req.messages) : raw
      const d = opts.delayMs ?? 0
      if (step.reasoning) {
        for (const p of pieces(step.reasoning, chunk)) {
          await pause(d)
          yield { type: 'reasoning', delta: p }
        }
      }
      if (step.text) {
        for (const p of pieces(step.text, chunk)) {
          await pause(d)
          yield { type: 'text', delta: p }
        }
      }
      for (const c of step.calls ?? []) {
        await pause(opts.callDelayMs ?? 0)
        yield { type: 'tool_call', call: { id: `call_${++callSeq}`, name: c.name, arguments: JSON.stringify(c.args) } }
      }
      yield { type: 'usage', inputTokens: 400 + JSON.stringify(req.messages).length / 4, outputTokens: 40 + (step.text?.length ?? 0) / 4 }
      yield { type: 'done', stop: step.calls?.length ? 'tool_calls' : 'end' }
    },
  }
}
