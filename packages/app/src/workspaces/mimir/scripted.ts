// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir before a model is connected to the tab: the real runtime with a client that plays scripted turns in place of
// a model. Each message picks the script whose words it matches; the script streams text and makes real tool calls,
// which run through the same tools a model would call. When the real agent arrives, only the client changes.
import { DEFAULT_CONFIG, RUNTIME_NOTES, askTool, createPilot, createScriptedClient, lookupTool, sheetBindTool, sheetTool, type LlmClient, type LlmMessage, type PilotTool, type ScriptStep } from '@slicerx/pilot'
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type Pilot, type PrinterHost, type SessionStore } from '@slicerx/contracts'

export interface MimirScript {
  id: string
  /** Words in the message that pick this script. */
  match: RegExp
  steps: ScriptStep[]
}

/** The text of the last thing the person said. */
function lastUser(messages: readonly LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user') return typeof m.content === 'string' ? m.content : ''
  }
  return ''
}

/** What mimir says to a message no script matches. */
const UNKNOWN: ScriptStep[] = [{ text: 'Scripted replies know three parts for now: a thermostat backplate, a box with a lid and a phone stand. Ask for one of them.' }]

const CANCELED: ScriptStep[] = [{ text: 'Nothing is built. Tell me which sizes are off and I will put up a new sheet.' }]

/** True for the tool reply of a sheet the person canceled. */
function canceledSheet(m: LlmMessage | undefined): boolean {
  if (m?.role !== 'tool') return false
  try {
    return (JSON.parse(m.content) as { result?: { confirmed?: unknown } }).result?.confirmed === false
  } catch {
    return false
  }
}

/**
 * A client that starts the matching script on each new message and plays it to the end, one step per request, the
 * way a model answers over several tool rounds.
 */
export function scriptRouter(scripts: readonly MimirScript[], opts: { delayMs?: number; callDelayMs?: number } = {}): LlmClient {
  let current: LlmClient | null = null
  let runs = 0
  return {
    provider: 'scripted',
    async *stream(req, signal) {
      // A new message starts its script; the tool rounds that follow it continue the same one.
      // A sheet the person canceled ends the script: nothing builds from sizes nobody confirmed.
      if (current !== null && canceledSheet(req.messages.at(-1))) current = createScriptedClient(CANCELED, { delayMs: opts.delayMs ?? 0 })
      // the runtime asking for a reply is not a new message: the script carries on
      else if (current === null || (req.messages.at(-1)?.role === 'user' && !RUNTIME_NOTES.has(lastUser(req.messages)))) {
        const script = scripts.find((s) => s.match.test(lastUser(req.messages)))
        current = createScriptedClient(script?.steps ?? UNKNOWN, { delayMs: opts.delayMs ?? 0, callDelayMs: opts.callDelayMs ?? 0 })
        runs++
      }
      // Each script numbers its calls from 1; the run number keeps call ids unique across the conversation.
      for await (const ev of current.stream(req, signal)) yield ev.type === 'tool_call' ? { ...ev, call: { ...ev.call, id: `r${runs}_${ev.call.id}` } } : ev
    },
  }
}

/** A printer host with no printers: the tab's toolset never reaches one. */
const NO_PRINTERS = { list: async () => [], plugins: async () => [] } as unknown as PrinterHost
/** Nothing in the tab asks for an approval; one that did would be refused. */
const NO_APPROVALS: ApprovalHost = {
  register: async () => undefined,
  grant: async () => {
    throw new Error('Approvals are not available in the mimir tab')
  },
  deny: async () => undefined,
} as unknown as ApprovalHost
const NO_LLM = {} as LlmTransport

/** The tools a scripted mimir can call in the tab. No printer tool is among them: a print always starts with a person. */
export function mimirTools(extra: readonly PilotTool<never>[] = []): PilotTool<never>[] {
  return [askTool(), lookupTool(), sheetTool(), sheetBindTool(), ...extra]
}

/** The tab's mimir: the runtime over the given tools, answering with the scripts. */
export function scriptedMimir(scripts: readonly MimirScript[], tools: readonly PilotTool<never>[], opts: { delayMs?: number; callDelayMs?: number; store?: SessionStore } = {}): Pilot {
  return createPilot({
    host: { printers: NO_PRINTERS, approvals: NO_APPROVALS, llm: NO_LLM },
    config: { ...DEFAULT_CONFIG, provider: 'scripted', model: 'scripted', maxSteps: 40, maxToolCalls: 60 },
    policy: DEFAULT_POLICY,
    client: scriptRouter(scripts, opts),
    builtins: false,
    tools: [...tools],
    ...(opts.store ? { store: opts.store } : {}),
  })
}
