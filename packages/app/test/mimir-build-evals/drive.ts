// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs one build eval case through the mimir tab as the desktop app makes it: the tab's options (session.ts
// tabPilotOptions), its tools (the questions, sheets and plan card, then the design toolset on the plate), the bundled
// knowledge base, the app's built-in commands and the edition's brain pack. The model is a live client or the
// recorded replies. The person is played by a fixed policy: confirm the dimension sheet as shown, press Go on the plan,
// pick the first real choice on any other question card, deny approvals for anything but design, and when a turn ends
// with nothing built, nudge once or twice. The score counts every one of those past the first sheet and Go (past one
// of each for every part, when the case asks for separate parts). A run that ends early (an error, the step cap, a
// cancel, the drive's own limit) or a replay that leaves recorded replies unused says so in its error.
import type { Host, MeshHandle, MeshPart, PilotConfig, PilotEvent, PrinterHost } from '@slicerx/contracts'
import { modelById } from '@slicerx/printer-catalog'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, type LlmClient } from '@slicerx/pilot'
import printerModels from '@slicerx/settings/printer-models.json' with { type: 'json' }
import type { ScriptStep, ScriptStepData } from '../../../pilot/src/provider/scripted'
import type { LlmMessage } from '../../../pilot/src/provider/types'
import type { BuildVolume } from '../../../mcp/evals/creative/mesh-checks'
import { builtinCommands } from '../../src/commands/builtin'
import { currentEdition } from '../../src/edition'
import { editionToolGroups, withBrain } from '../../src/pilot-connect/brain'
import { pilotModel } from '../../src/pilot-connect/llm'
import { chatNotesGo, pilotMemory } from '../../src/pilot-connect/memory'
import { setHostSlices } from '../../src/state/model-mode'
import { get, set } from '../../src/state/store'
import { bundledKb } from '../../src/workspaces/mimir/kb'
import { clearPlans, PLAN_GO } from '../../src/workspaces/mimir/plan-tool'
import { tabPilotOptions, toolsFor } from '../../src/workspaces/mimir/session'
import type { BuildCase } from './cases'
import { classifyNoBuild, placed, scoreCase, type CaseScore, type UserTurn } from './score'

/** The model the eval runs on unless told otherwise: the tab's Haiku. */
export const EVAL_MODEL = 'claude-haiku-5-5'

/** What the eval says when a turn ends with nothing built, by why. */
export const NUDGES = {
  asked: 'Use common sizes and sensible defaults, then build it',
  declined: 'Build it as I described, please',
  none: 'Go ahead and build it',
} as const
/** Nudges past this many end the run. */
export const MAX_NUDGES = 2

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const handle = (name: string): MeshHandle => ({ id: `h-${name}`, hash: name, name, triangles: 0, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }
/** The workspaces a desktop window has, for the commands that switch between them. */
const WORKSPACES = [
  { id: 'prepare', label: 'Slice' },
  { id: 'library', label: 'My models' },
  { id: 'printers', label: 'Printers' },
]

/** The tab's config for a key on `model`, as tabMimir makes it for a person's own Anthropic key. */
export function tabConfig(model: string): PilotConfig {
  const chosen = pilotModel(currentEdition(), { mode: 'on', provider: 'anthropic', model }, false)
  if (!chosen) throw new Error('no model config')
  const { models: _plan, ...rest } = DEFAULT_CONFIG
  return withBrain({ ...rest, ...chosen }, currentEdition())
}

export function buildVolume(printer: string): BuildVolume {
  const entry = Object.entries((printerModels as { models: Record<string, string> }).models).find(([, v]) => v === printer)
  const model = entry ? modelById(entry[0]) : undefined
  if (!model) throw new Error(`No build volume for printer ${printer}`)
  return model.buildVolume
}

/** A recorded reply, with the tool results the model had just read when it wrote it. */
export interface EvalStep extends ScriptStepData {
  seen?: string[]
}

/** The tool results after the last assistant message: what the model read just before this reply. */
function toolResultsSeen(messages: readonly LlmMessage[]): string[] {
  let k = messages.length
  while (k > 0 && messages[k - 1]!.role !== 'assistant') k--
  return messages.slice(k).flatMap((m) => (m.role === 'tool' ? [m.content] : []))
}

// ids the app makes from the time and a counter: designs and objects (obj_...), plans (plan_...), steps (s...) and
// dimensions (d...), each with at least one digit
const MADE_ID = /\b(?:obj|plan|vol|plate)_[0-9a-z~]+\b|\b[sd](?=[0-9a-z]*\d)[0-9a-z]{9,}\b/g

/**
 * The recorded replies as script steps that swap the ids of the live run for the ones this run made. Each step pairs
 * the ids in the results it saw live with the ids in the results this run's model reads at the same point, in order,
 * and replaces them in its tool calls; the pairs build up over the run.
 */
export function replaySteps(steps: readonly EvalStep[]): ScriptStep[] {
  const ids = new Map<string, string>()
  return steps.map(({ seen, ...step }) => (messages: LlmMessage[]): ScriptStepData => {
    const was = (seen ?? []).join('\n').match(MADE_ID) ?? []
    const now = toolResultsSeen(messages).join('\n').match(MADE_ID) ?? []
    was.forEach((id, i) => {
      const to = now[i]
      if (to && to !== id && id.slice(0, 3) === to.slice(0, 3)) ids.set(id, to)
    })
    if (!ids.size || !step.calls) return step
    let text = JSON.stringify(step.calls)
    for (const [from, to] of ids) text = text.split(from).join(to)
    return { ...step, calls: JSON.parse(text) as NonNullable<ScriptStepData['calls']> }
  })
}

export interface CaseRun {
  score: CaseScore
  turns: UserTurn[]
  /** The model's replies, one per request, for a recording. */
  steps: EvalStep[]
  /** Every geom.* or design.* call, with ok or the error summary. */
  calls: string[]
  reply: string
  error?: string
}

/** One case: `client` is the live model; without it `steps` replay. */
export async function driveCase(c: BuildCase, opts: { client?: LlmClient; steps?: EvalStep[]; model?: string; timeoutMs?: number }): Promise<CaseRun> {
  setHostSlices(true)
  clearPlans()
  set({ plate: [], selection: null, selectedIds: [], historyEdit: null, printerModel: { vendor: 'Bambu Lab', model: 'P1S' }, profile: null, overrides: {} })
  const script = opts.client ? undefined : createScriptedClient(replaySteps(opts.steps ?? []), { chunk: false })
  const inner = opts.client ?? script!
  const steps: EvalStep[] = []
  // records each request's reply as a step, the shape the scripted client replays (as the creative eval does)
  const client: LlmClient = {
    provider: inner.provider,
    async *stream(req, signal) {
      const seen = toolResultsSeen(req.messages)
      const step: EvalStep = seen.length ? { seen } : {}
      try {
        for await (const ev of inner.stream(req, signal)) {
          if (ev.type === 'text') step.text = (step.text ?? '') + ev.delta
          if (ev.type === 'tool_call') {
            let args: Record<string, unknown> = {}
            try {
              const parsed: unknown = JSON.parse(ev.call.arguments || '{}')
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
            } catch {
              args = { unparsed: ev.call.arguments }
            }
            ;(step.calls ??= []).push({ name: ev.call.name, args })
          }
          yield ev
        }
      } finally {
        if (!req.webSearch && (step.text || step.calls)) steps.push(step)
      }
    },
  }
  const host = { kind: 'web', slicer: loader, printers, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
  const config = tabConfig(opts.model ?? EVAL_MODEL)
  const noLlm = { available: async () => true, stream: () => { throw new Error('the eval passes its own client') } }
  const pilot = createPilot(
    tabPilotOptions(host, { llm: noLlm, config, kb: await bundledKb(), tools: toolsFor(loader), commands: builtinCommands(host, WORKSPACES), client, memory: pilotMemory(currentEdition(), { where: chatNotesGo(config, true) }), toolGroups: editionToolGroups(currentEdition()) }),
  )
  const events: PilotEvent[] = []
  const turns: UserTurn[] = []
  const ac = new AbortController()
  const limitMs = opts.timeoutMs ?? (opts.client ? 480_000 : 120_000)
  const timer = setTimeout(() => ac.abort(), limitMs)
  // why the run ended early, said by the pilot: an error it showed, the step cap, or a cancel the drive did not ask for
  let ended: string | undefined
  const turn = async (message: string): Promise<string> => {
    let text = ''
    for await (const ev of pilot.run(`eval-${c.id}`, message, { signal: ac.signal })) {
      events.push(ev)
      if (ev.type === 'text') text += ev.delta
      // a notice that mimir waits or goes on (waiting) is not an error
      if (ev.type === 'error' && !ev.waiting) ended ??= `the run ended on an error: ${ev.message}`
      if (ev.type === 'done') {
        if (ev.stopReason === 'error') ended ??= 'the run ended on an error'
        else if (ev.stopReason === 'max_steps') ended ??= 'the run stopped at the step cap'
        else if (ev.stopReason === 'canceled' && !ac.signal.aborted) ended ??= 'the run was canceled'
      }
      // only design is asked for: printing, profiles and notes stay with the person
      if (ev.type === 'approval_request') void pilot.resolveApproval(ev.request.id, { kind: 'deny', reason: 'not part of this request' })
      if (ev.type === 'sheet') {
        turns.push({ kind: 'sheet', title: ev.sheet.title })
        void pilot.answerSheet!(ev.sheet.id, {})
      }
      if (ev.type === 'ask') {
        const go = ev.choices.find((ch) => ch.id.startsWith(`${PLAN_GO}:`))
        if (go) {
          turns.push({ kind: 'go', part: ev.question })
          void pilot.answer!(ev.askId, go.id)
        } else {
          const pick = ev.choices.find((ch) => !/\bnothing\b/i.test(ch.label)) ?? ev.choices[0]
          turns.push({ kind: 'answer', question: ev.question, picked: pick?.label ?? '' })
          if (pick) void pilot.answer!(ev.askId, pick.id)
        }
      }
    }
    return text
  }
  const built = (): boolean => get().plate.length > 0
  let reply = ''
  let firstReply = ''
  let firstBuilt = false
  let error: string | undefined
  try {
    turns.push({ kind: 'message', text: c.prompt })
    reply = firstReply = await turn(c.prompt)
    firstBuilt = built()
    for (let n = 0; n < MAX_NUDGES && !built(); n++) {
      const why = classifyNoBuild(reply)
      turns.push({ kind: 'nudge', text: NUDGES[why], why })
      reply = await turn(NUDGES[why])
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    clearTimeout(timer)
  }
  // an abort ends the turn quietly (it reads as a canceled reply), so say it here or a stalled run scores as a finished one
  if (ac.signal.aborted && !error) error = `stopped after ${limitMs / 1000} s`
  error ??= ended
  // a replay that ends before its recorded replies do no longer follows what the model did live
  const left = script?.remaining() ?? 0
  if (left > 0) error ??= `the replay left ${left} recorded repl${left === 1 ? 'y' : 'ies'} unused`
  const parts = placed(get().plate)
  const score = scoreCase(c, { events, turns, parts, firstReply, firstBuilt, bed: buildVolume(c.machine.printer), wallMm: Math.round(2 * c.machine.nozzle * 1000) / 1000 })
  const results = new Map(events.flatMap((e) => (e.type === 'tool_result' ? [[e.callId, e] as const] : [])))
  const calls = events.flatMap((e) => {
    if (e.type !== 'tool_call' || !(e.tool.startsWith('geom.') || e.tool.startsWith('design.') || e.tool.startsWith('pilot.'))) return []
    const r = results.get(e.callId)
    return [`${e.tool} ${r ? (r.ok === false ? `FAIL ${r.summary ?? ''}`.slice(0, 160) : 'ok') : 'no result'}`]
  })
  const run: CaseRun = { score, turns, steps, calls, reply: firstReply.slice(0, 800) }
  if (error) run.error = error
  return run
}
