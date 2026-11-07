// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs one creative prompt through the whole mimir loop (a recorded reply, or a live model when the caller passes
// one) with the geometry engine as the host, then scores the parts it added to the project.
import type { MeshPart, PilotEvent, PilotMachine } from '@slicerx/contracts'
import { neutralEdition } from '@slicerx/edition-config'
import { modelById } from '@slicerx/printer-catalog'
import printerModels from '@slicerx/settings/printer-models.json' with { type: 'json' }
import { assessFit } from '../../skills/fit_check/index'
import { createScriptedClient, type ScriptStepData } from '../../src/provider/scripted'
import type { LlmClient } from '../../src/provider/types'
import type { ToolHost } from '../../src/tool'
import { createEvalEnv, noteApprovals, type EvalHosts } from '../harness'
import { bedFit, bodyCount, closure, minWall, movingGaps, type BuildVolume } from './mesh-checks'
import type { CreativePrompt } from './prompts'

/** The tools that add a designed part to the project. */
export const MODEL_TOOLS = new Set(['make_model', 'text_to_part'])

/** The build volume of the eval machine's printer, from the printer catalog. */
export function buildVolumeOf(machine: PilotMachine): BuildVolume {
  const entry = Object.entries((printerModels as { models: Record<string, string> }).models).find(([, v]) => v === machine.printer)
  const model = entry ? modelById(entry[0]) : undefined
  if (!model) throw new Error(`No build volume for printer ${machine.printer}`)
  return model.buildVolume
}

/** Thinnest wall a nozzle prints reliably: two lines. */
export const wallLimitMm = (m: PilotMachine): number => Math.round(2 * m.nozzle * 1000) / 1000

/** The modeled gap a print in place joint needs per side on this machine, from the fit rule (fit_check). */
export function clearanceNeed(m: PilotMachine, gapMm: number): { moves: boolean; suggestedGapMm: number } {
  const fit = assessFit({ gapMm, feature: 'print_in_place', direction: 'xy', layerHeight: m.nozzle / 2, lineWidth: m.nozzle * 1.05, nozzle: m.nozzle, material: m.material })
  return { moves: fit.outcome === 'slides', suggestedGapMm: fit.suggestedGapMm }
}

export interface Check {
  pass: boolean
  detail: string
}

export interface CreativeScore {
  parses: Check
  watertight?: Check
  bodies?: Check
  minWall?: Check
  bedFit?: Check
  /** Mechanisms only. */
  clearance?: Check
  pass: boolean
}

/** Scores the parts a run produced against the prompt's expectations. `parsed` false fails the run on its own. */
export function scoreParts(p: CreativePrompt, parsed: Check, parts: MeshPart[]): CreativeScore {
  if (!parsed.pass) return { parses: parsed, pass: false }
  const c = closure(parts)
  const watertight: Check = { pass: c.watertight, detail: c.watertight ? 'closed' : `open ${c.openEdges}, non-manifold ${c.nonManifoldEdges}, flipped ${c.flippedEdges}` }
  const n = bodyCount(parts)
  const bodies: Check = { pass: n >= p.bodies[0] && n <= p.bodies[1], detail: `${n} (want ${p.bodies[0]} to ${p.bodies[1]})` }
  const w = minWall(parts)
  const limit = wallLimitMm(p.machine)
  const wall: Check = { pass: w.samples > 0 && w.minWallMm >= limit, detail: `${w.minWallMm} mm (want ${limit} mm or more)` }
  const bed = buildVolumeOf(p.machine)
  const fit = bedFit(parts, bed)
  const bedSize = bed.shape === 'circular' ? `${bed.diameter} round by ${bed.z}` : `${bed.x} by ${bed.y} by ${bed.z}`
  const bedCheck: Check = { pass: fit.fits, detail: `${fit.sizeMm.join(' by ')} mm on ${bedSize} mm` }
  const out: CreativeScore = { parses: parsed, watertight, bodies, minWall: wall, bedFit: bedCheck, pass: false }
  if (p.mechanism) {
    const g = movingGaps(parts)
    if (g.minGapMm === null) out.clearance = { pass: false, detail: 'no bodies face each other, so nothing moves' }
    else {
      const need = clearanceNeed(p.machine, g.minGapMm)
      out.clearance = { pass: need.moves, detail: `${g.minGapMm} mm over ${g.pairs} pair${g.pairs === 1 ? '' : 's'} (want ${need.suggestedGapMm} mm or more)` }
    }
  }
  out.pass = [out.watertight, out.bodies, out.minWall, out.bedFit, out.clearance].every((x) => x === undefined || x.pass)
  return out
}

/**
 * mimir as the eval runs it: the desktop app's tab (the host slices, so the whole toolset rather than the browser
 * build's cad scope) in the edition the app runs as without one of its own, through the tab options the app's tab is
 * made from (src/tab-options.ts). The SlicerX edition sets no brain pack tool switches either, so its groups are the
 * same (none off).
 */
export const CREATIVE_TAB = { slices: true, edition: neutralEdition(), editionName: 'neutral' } as const

/** The eval environment for one prompt, with the tab's options. `tab` overrides the surface (the browser build: slices false). */
export function creativeEnv(p: CreativePrompt, client: LlmClient, hosts: EvalHosts = {}, tab: { slices: boolean } = CREATIVE_TAB) {
  return createEvalEnv({ client, machine: p.machine, objects: [], hosts: () => hosts, tab: { slices: tab.slices, edition: CREATIVE_TAB.edition } })
}

/**
 * Why a reply built nothing. `declined`: it says the part can't be modeled or built (often offering a simpler version
 * and asking which one; the refusal wins). `asked`: it does not decline, and puts a question to the person (a sentence
 * ending in a question mark). `none`: neither, such as an empty reply, a statement, or a reply cut off.
 */
export type NoBuild = 'asked' | 'declined' | 'none'

const DECLINES = /\b(?:can(?:'|\u2019|no)t|cannot|unable to|not able to)\s+(?:\w+\s+){0,3}?(?:model|build|make|design|sculpt)\b|\boutside what (?:I|the tools?) can\b|\btools? (?:can(?:'|\u2019|no)t|cannot|only)\b/i
const ASKS = /\?[)"'\u201d\u2019*_]*(?:\s|$)/

export function classifyNoBuild(reply: string): NoBuild {
  if (DECLINES.test(reply)) return 'declined'
  if (ASKS.test(reply)) return 'asked'
  return 'none'
}

/** What the eval says, once, when the model asks a question instead of building. */
export const DEFAULT_ANSWER = 'Use common sizes and sensible defaults, then build it'

export interface PromptRun {
  parsed: Check
  parts: MeshPart[]
  calls: string[]
  reply: string
  /** What the model sent back, one step per provider request (for --record). */
  steps: ScriptStepData[]
  /** Why nothing was built, when no design tool was called. */
  noBuild?: NoBuild
  /** The model asked, and the eval gave it the default answer. */
  answered: boolean
  /** Why the recording no longer stands for what a live run would do (replay only). */
  stale?: string
  error?: string
}

/**
 * One prompt through mimir. `client` is the live model; without it the recorded steps replay. Design tools are
 * approved as the person would; anything else is denied. When the reply builds nothing and asks a question, the eval
 * answers once with DEFAULT_ANSWER and lets the model go on (`defaultAnswer`, on unless false). A replay answers only
 * when the recording was captured with the answer (`answerRecorded`); a recorded question without it is marked stale.
 */
export async function runPrompt(p: CreativePrompt, opts: { geom: ToolHost['geom']; steps?: ScriptStepData[]; client?: LlmClient; timeoutMs?: number; defaultAnswer?: boolean; answerRecorded?: boolean }): Promise<PromptRun> {
  const inner = opts.client ?? createScriptedClient(opts.steps ?? [], { chunk: false })
  const steps: ScriptStepData[] = []
  // Records each request's reply as a step, the shape the scripted client replays.
  const client: LlmClient = {
    provider: inner.provider,
    async *stream(req, signal) {
      const step: ScriptStepData = {}
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
  const env = creativeEnv(p, client, opts.geom ? { geom: opts.geom } : {})
  const events: PilotEvent[] = []
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? (opts.client ? 300_000 : 60_000))
  let error: string | undefined
  /** One message to mimir in the prompt's chat; returns the reply's text. */
  const turn = async (message: string): Promise<string> => {
    let text = ''
    for await (const ev of env.pilot.run(`creative-${p.id}`, message, { signal: ac.signal, context: { project: 'creative', machine: p.machine, objects: [] } })) {
      events.push(ev)
      if (ev.type === 'text') text += ev.delta
      noteApprovals(env.audit, ev)
      if (ev.type === 'approval_request') void env.pilot.resolveApproval(ev.request.id, MODEL_TOOLS.has(ev.request.tool) ? { kind: 'approve' } : { kind: 'deny', reason: 'not part of a design request' })
    }
    return text
  }
  const built = (): boolean => events.some((e) => e.type === 'tool_call' && MODEL_TOOLS.has(e.tool))
  let text = ''
  let answered = false
  let stale: string | undefined
  try {
    text = await turn(p.prompt)
    if (!built() && classifyNoBuild(text) === 'asked' && opts.defaultAnswer !== false) {
      if (!opts.client && !opts.answerRecorded) stale = 'recorded before the default answer: the model asked a question, which a live run now answers once before scoring'
      else {
        answered = true
        text = await turn(DEFAULT_ANSWER)
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    clearTimeout(timer)
  }
  const noBuild = built() ? undefined : classifyNoBuild(text)
  const calls = events.filter((e): e is Extract<PilotEvent, { type: 'tool_call' }> => e.type === 'tool_call')
  const results = new Map(events.filter((e): e is Extract<PilotEvent, { type: 'tool_result' }> => e.type === 'tool_result').map((r) => [r.callId, r]))
  const modelCalls = calls.filter((c) => MODEL_TOOLS.has(c.tool))
  const last = modelCalls.at(-1)
  const lastResult = last ? results.get(last.callId) : undefined
  const parts: MeshPart[] = []
  for (const o of env.project.objects()) parts.push(...((await o.mesh?.()) ?? []))
  let parsed: Check
  if (!last) parsed = { pass: false, detail: `no design tool was called: ${noBuild ?? 'none'}${answered ? ', after the default answer' : ''}` }
  else if (!lastResult || lastResult.ok === false) parsed = { pass: false, detail: `${last.tool}: ${lastResult?.summary ?? 'no result'}` }
  else if (!parts.length) parsed = { pass: false, detail: `${last.tool} added no parts` }
  else parsed = { pass: true, detail: `${last.tool}, ${parts.length} mesh part${parts.length === 1 ? '' : 's'}` }
  const run: PromptRun = {
    parsed,
    parts,
    calls: calls.map((c) => c.tool),
    reply: events.map((e) => (e.type === 'text' ? e.delta : '')).join('').slice(0, 600),
    steps,
    answered,
  }
  if (noBuild) run.noBuild = noBuild
  if (stale) run.stale = stale
  if (error) run.error = error
  return run
}
