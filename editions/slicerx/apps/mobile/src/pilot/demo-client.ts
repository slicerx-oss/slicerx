// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The model stand-in the phone app uses until the phone reaches a model provider
// through the SlicerX service. It answers from what the tools return, using
// the real Pilot runtime, tools and approval gate, so every printer action
// still stops at an approval card. It handles fleet status questions and
// pause, resume and cancel requests; anything else gets a pointer to the
// screen that does it.
import type { LlmClient, LlmEvent, LlmMessage, LlmRequest } from '@slicerx/pilot'

export interface DemoClientOptions {
  /** Pause per streamed word, ms. 0 in tests. */
  delayMs?: number
}

type Step = { reasoning?: string; text?: string; call?: { name: string; args: Record<string, unknown> } }

interface ListedPrinter {
  id: string
  name: string
  model?: string
  status?: { state?: string; jobName?: string; progress?: number; timeLeftS?: number; message?: string }
}

const REQUEST_MARK = 'User request:\n'

const VERBS = { pause: 'paused', resume: 'resumed', cancel: 'canceled' } as const
type Control = keyof typeof VERBS

const pause = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

function hm(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function toolBody(m: LlmMessage | undefined): { ok: boolean; summary: string; data: unknown } {
  if (!m || m.role !== 'tool') return { ok: false, summary: '', data: null }
  try {
    const v = JSON.parse(m.content) as { ok?: boolean; summary?: string; result?: unknown }
    const r = v.result as { untrusted?: boolean; data?: unknown } | undefined
    return { ok: v.ok !== false, summary: v.summary ?? '', data: r && typeof r === 'object' && 'untrusted' in r ? r.data : r }
  } catch {
    return { ok: false, summary: m.content.slice(0, 200), data: null }
  }
}

function printerIdIn(text: string): string | null {
  const m = /\bbay[\s-]*(\d+)\b/i.exec(text)
  return m ? `bay-${m[1]}` : null
}

function controlIn(text: string): Control | null {
  const t = text.toLowerCase()
  if (/\b(resume|continue|unpause)\b/.test(t)) return 'resume'
  if (/\b(cancel|abort|stop)\b/.test(t)) return 'cancel'
  if (/\bpause\b/.test(t)) return 'pause'
  return null
}

function fleetLine(p: ListedPrinter): string {
  const s = p.status ?? {}
  switch (s.state) {
    case 'printing': {
      const pct = s.progress !== undefined ? `${Math.round(s.progress * 100)}%` : ''
      const left = s.timeLeftS !== undefined ? `${hm(s.timeLeftS)} left` : ''
      return `${p.name} is printing ${s.jobName ?? 'a job'}${pct || left ? ` (${[pct, left].filter(Boolean).join(', ')})` : ''}.`
    }
    case 'paused':
      return `${p.name} is paused${s.message ? `: "${s.message}"` : ''}.`
    case 'finished':
      return `${p.name} finished ${s.jobName ?? 'its job'} and needs the bed cleared.`
    case 'error':
      return `${p.name} reported an error${s.message ? `: "${s.message}"` : ''}.`
    case 'offline':
      return `${p.name} is offline.`
    case 'preparing':
      return `${p.name} is heating up.`
    default:
      return `${p.name} is idle.`
  }
}

/** Decides the next step from the conversation since the person's last message. */
export function nextStep(messages: LlmMessage[]): Step {
  let u = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      u = i
      break
    }
  }
  // The runtime puts the run context (date, permissions) ahead of the person's words.
  const raw = u >= 0 ? (messages[u] as { content: string }).content : ''
  const mark = raw.lastIndexOf(REQUEST_MARK)
  const ask = mark >= 0 ? raw.slice(mark + REQUEST_MARK.length) : raw
  const since = messages.slice(u + 1)
  const calls = since.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : []))
  const lastTool = [...since].reverse().find((m) => m.role === 'tool')
  const control = controlIn(ask)
  const target = printerIdIn(ask)

  if (control && target) {
    if (calls.length === 0) {
      return {
        reasoning: `The request is to ${control} ${target}. That moves or stops a printer, so it goes through an approval.`,
        text: `I'll ${control} the print on ${target.replace('bay-', 'Bay ')}. This needs your approval first.`,
        call: { name: `printer.${control}`, args: { printerId: target } },
      }
    }
    const r = toolBody(lastTool)
    return { text: r.ok ? `Done. ${target.replace('bay-', 'Bay ')} is ${VERBS[control]}.` : `Nothing changed on ${target.replace('bay-', 'Bay ')}. ${r.summary}` }
  }

  if (control && !target) return { text: `Which printer should I ${control}? Name it, for example "${control} Bay 3".` }

  if (/\b(slice|upload|send)\b/i.test(ask)) {
    return { text: 'Open the Slice tab to pick a model, a printer and Easy settings. The cloud slices it, and you approve before anything reaches the printer.' }
  }

  if (calls.length === 0) {
    return {
      reasoning: 'A status question. Read the fleet first, then look closer at anything that needs the person.',
      text: 'Checking your printers.',
      call: { name: 'printer.list', args: {} },
    }
  }
  const listed = since.find((m) => m.role === 'tool')
  const fleet = (toolBody(listed).data as ListedPrinter[] | null) ?? []
  const waiting = fleet.find((p) => p.status?.state === 'paused' || p.status?.state === 'error')
  if (calls.length === 1 && waiting) {
    return { text: `${waiting.name} needs attention. Reading its status.`, call: { name: 'printer.status', args: { printerId: waiting.id } } }
  }
  const lines = fleet.map(fleetLine)
  const tip = waiting ? `\n\nSay "resume ${waiting.name}" when it is ready and I'll ask before I do it.` : ''
  return { text: `${lines.join(' ')}${tip}` }
}

export function createDemoClient(opts: DemoClientOptions = {}): LlmClient {
  const delay = opts.delayMs ?? 18
  let callSeq = 0
  const words = (s: string): string[] => s.match(/\s*\S+/g) ?? []
  return {
    provider: 'pocket-demo',
    async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmEvent> {
      if (req.webSearch) {
        yield { type: 'text', delta: 'Web lookups need a mimir connection.' }
        yield { type: 'done', stop: 'end' }
        return
      }
      if (req.toolChoice === 'none') {
        yield { type: 'text', delta: 'Stopped. Nothing was sent to a printer.' }
        yield { type: 'done', stop: 'end' }
        return
      }
      const step = nextStep(req.messages)
      for (const w of words(step.reasoning ?? '')) {
        if (signal?.aborted) return
        await pause(delay / 2)
        yield { type: 'reasoning', delta: w }
      }
      for (const w of words(step.text ?? '')) {
        if (signal?.aborted) return
        await pause(delay)
        yield { type: 'text', delta: w }
      }
      if (step.call) {
        await pause(delay * 8)
        yield { type: 'tool_call', call: { id: `pocket_${++callSeq}`, name: step.call.name, arguments: JSON.stringify(step.call.args) } }
      }
      yield { type: 'usage', inputTokens: 0, outputTokens: 0 }
      yield { type: 'done', stop: step.call ? 'tool_calls' : 'end' }
    },
  }
}
