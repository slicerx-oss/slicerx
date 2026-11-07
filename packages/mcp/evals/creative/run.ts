// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs one creative prompt through the whole mimir loop (a recorded reply, or a live model when the caller passes
// one) on the mimir tab's tools, with the geometry engine as the host, then scores the parts its designs built.
import { bakeMesh, type Design, type EngineCall } from '@slicerx/cad-history'
import { historyPart } from '@slicerx/cad-history/mesh-part'
import type { Bed, CommandSpec, MeshPart, PilotEvent, PilotMachine } from '@slicerx/contracts'
import { neutralEdition, type EditionConfig } from '@slicerx/edition-config'
import { modelById } from '@slicerx/printer-catalog'
import printerModels from '@slicerx/settings/printer-models.json' with { type: 'json' }
import type { LlmClient, ToolHost } from '@slicerx/pilot'
import { assessFit, createEvalEnv, createScriptedClient, noteApprovals, type EvalHosts, type ScriptStepData } from '@slicerx/pilot/evals'
import { createCardPlans, createPlanRegistry, tabToolset } from '../../src/toolset'
import { headlessDesignHost, plainBed } from './design-host'
import { bedFit, bodyCount, closure, minWall, movingGaps, type BuildVolume, type GapReport } from './mesh-checks'
import type { CreativePrompt } from './prompts'

/** The tab's design tools (design.* and geom.*), the one way it builds a part: a reply that calls none built nothing. */
export const isDesignTool = (name: string): boolean => name.startsWith('design.') || name.startsWith('geom.')

/** The build volume of the eval machine's printer, from the printer catalog. */
export function buildVolumeOf(machine: PilotMachine): BuildVolume {
  const entry = Object.entries((printerModels as { models: Record<string, string> }).models).find(([, v]) => v === machine.printer)
  const model = entry ? modelById(entry[0]) : undefined
  if (!model) throw new Error(`No build volume for printer ${machine.printer}`)
  return model.buildVolume
}

/** Thinnest wall a nozzle prints reliably: two lines. */
export const wallLimitMm = (m: PilotMachine): number => Math.round(2 * m.nozzle * 1000) / 1000

/**
 * The modeled gap a print in place joint needs on this machine, from the fit rule (fit_check): per side for parts side
 * by side (xy), and in whole layers above the sag for one over the other (z).
 */
export function clearanceNeed(m: PilotMachine, gapMm: number, direction: 'xy' | 'z' = 'xy'): { moves: boolean; suggestedGapMm: number } {
  const fit = assessFit({ gapMm, feature: 'print_in_place', direction, layerHeight: m.nozzle / 2, lineWidth: m.nozzle * 1.05, nozzle: m.nozzle, material: m.material })
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

/**
 * The clearance score for a mechanism from the gaps the engine measured (movingGaps): every pair of bodies close enough
 * to move must keep the fit rule's gap for its direction, and none may touch. No gaps measured: no engine.
 */
export function clearanceCheck(m: PilotMachine, gaps: GapReport | undefined): Check {
  if (!gaps) return { pass: false, detail: 'no geometry engine to measure the gaps' }
  if (!gaps.pairs) return { pass: false, detail: 'no bodies face each other, so nothing moves' }
  const fused = gaps.gaps.filter((g) => g.kind === 'fused').length
  if (fused) return { pass: false, detail: fused === 1 ? '1 pair touches or overlaps, so it prints as one piece' : `${fused} pairs touch or overlap, so they print as one piece` }
  const judged = gaps.gaps.map((g) => ({ g, need: clearanceNeed(m, g.gapMm, g.kind === 'vertical' ? 'z' : 'xy') }))
  const worst = judged.find((j) => !j.need.moves) ?? judged[0]!
  const what = worst.g.kind === 'vertical' ? 'vertical gap' : 'side gap'
  return { pass: judged.every((j) => j.need.moves), detail: `${worst.g.gapMm} mm ${what} over ${gaps.pairs} pair${gaps.pairs === 1 ? '' : 's'} (want ${worst.need.suggestedGapMm} mm or more)` }
}

/**
 * Scores the parts a run produced against the prompt's expectations. `parsed` false fails the run on its own. `gaps`
 * are the gaps the engine measured between the bodies (movingGaps), for a mechanism's clearance.
 */
export function scoreParts(p: CreativePrompt, parsed: Check, parts: MeshPart[], gaps?: GapReport): CreativeScore {
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
  if (p.mechanism) out.clearance = clearanceCheck(p.machine, gaps)
  out.pass = [out.watertight, out.bodies, out.minWall, out.bedFit, out.clearance].every((x) => x === undefined || x.pass)
  return out
}

/**
 * mimir as the eval runs it: the desktop app's tab (the host slices, so the whole toolset rather than the browser
 * build's cad scope) in the edition the app runs as without one of its own, through the tab options the app's tab is
 * made from (@slicerx/pilot tab-options.ts). The SlicerX edition sets no brain pack tool switches either, so its groups
 * are the same (none off).
 */
export const CREATIVE_TAB = { slices: true, edition: neutralEdition(), editionName: 'neutral' } as const

/** What the eval says when a design call needs the engine and there is none. */
const NO_ENGINE = 'There is no geometry engine here: build packages/geom/wasm (scripts/build.sh) or sx-geom first.'

/** The parts of a design in the plate's frame, as the project's object holds them. */
const designParts = (d: Design): MeshPart[] => d.parts.map((m) => historyPart(bakeMesh(m, d.transform)))

function sizeOf(parts: readonly MeshPart[]): [number, number, number] {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) for (let i = 0; i + 2 < p.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k] ?? 0, p.positions[i + k] ?? 0)
    hi[k] = Math.max(hi[k] ?? 0, p.positions[i + k] ?? 0)
  }
  const r = (k: number): number => (Number.isFinite(lo[k]) ? Math.round(((hi[k] ?? 0) - (lo[k] ?? 0)) * 100) / 100 : 0)
  return [r(0), r(1), r(2)]
}

/**
 * The eval environment for one prompt, with the tab's options and the tab's tools (@slicerx/mcp toolset.ts
 * tabToolset, as the app's tab makes them): its questions, lookups, sheets and design.plan, and the design toolset on
 * a design host of the eval's own (design-host.ts) over the eval's geometry engine. A design with a body is an object
 * in the project, as a design on the app's plate is. `tab` overrides the surface (the browser build: slices false) and
 * the edition.
 */
export function creativeEnv(p: CreativePrompt, client: LlmClient, hosts: EvalHosts = {}, tab: { slices: boolean; edition?: EditionConfig; commands?: readonly CommandSpec[] } = CREATIVE_TAB) {
  const geom = hosts.geom
  // the engine as the app's worker calls it: every mesh asked for with its faces
  const engine: EngineCall = (op, request) => (geom ? geom.run(op, request && typeof request === 'object' && !Array.isArray(request) ? { ...request, withFaces: true } : request) : Promise.reject(new Error(NO_ENGINE)))
  let project: ReturnType<typeof createEvalEnv>['project'] | undefined
  // each design's parts and size as the project's object holds them, updated in place as its steps land
  const placed = new Map<string, { parts: MeshPart[]; bboxMm: [number, number, number] }>()
  const changed = (d: Design): void => {
    if (!project) return
    const parts = designParts(d)
    const seen = placed.get(d.id)
    if (seen) {
      seen.parts.splice(0, seen.parts.length, ...parts)
      seen.bboxMm.splice(0, 3, ...sizeOf(parts))
      return
    }
    if (!parts.length) return
    const entry = { parts, bboxMm: sizeOf(parts) }
    placed.set(d.id, entry)
    void project.addObject?.({ id: d.id, name: d.name, bboxMm: entry.bboxMm }, entry.parts)
  }
  // the machine's bed, which a body built off it lands on as on the app's plate
  const v = buildVolumeOf(p.machine)
  const bed: Bed = v.shape === 'circular' ? { widthMm: v.diameter, depthMm: v.diameter, heightMm: v.z, round: true } : { widthMm: v.x, depthMm: v.y, heightMm: v.z }
  const designs = headlessDesignHost(engine, { changed, bed: (id) => plainBed(bed, () => designs.list().filter((d) => d.id !== id && d.parts.length)) })
  let plans = 0
  const tools = tabToolset(designs, createCardPlans(createPlanRegistry()), { nozzleMm: () => p.machine.nozzle, newPlanId: () => `plan_${++plans}` })
  const env = createEvalEnv({ client, machine: p.machine, objects: [], hosts: () => hosts, tools, tab: { slices: tab.slices, edition: tab.edition ?? CREATIVE_TAB.edition, ...(tab.commands ? { commands: [...tab.commands] } : {}) } })
  project = env.project
  return { ...env, designs }
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
  /** For a mechanism with parts and an engine: the gaps between its bodies, as the engine's fit check measures them. */
  gaps?: GapReport
  /** The model asked (in its reply, or with pilot.ask), and the eval gave it the default answer. */
  answered: boolean
  /** Why the recording no longer stands for what a live run would do (replay only). */
  stale?: string
  error?: string
}

/** Why a recording from before the eval ran on the tab's tools is stale. */
export const STALE_TOOLS = 'recorded before the eval had the tab\'s design tools (it called text_to_part or no tool), so a live run captures it again on design.* and geom.*'

/**
 * One prompt through mimir on the tab's tools. `client` is the live model; without it the recorded steps replay.
 * The eval stands in for the person: a design tool's approval is given, anything else is denied; a plan card gets Go,
 * a dimension sheet is confirmed as shown, and a question card (pilot.ask) gets the default answer as the person's own
 * words, once; any other card is dismissed. When the reply builds nothing and asks a question, the eval answers once
 * with DEFAULT_ANSWER and lets the model go on (`defaultAnswer`, on unless false; the card and the reply share the one
 * answer). A replay answers only when the recording was captured with the answer (`answerRecorded`); a recorded
 * question without it is marked stale, and so is a recording from before the tab's tools (`tabTools` unset).
 */
export async function runPrompt(p: CreativePrompt, opts: { geom: ToolHost['geom']; steps?: ScriptStepData[]; client?: LlmClient; timeoutMs?: number; defaultAnswer?: boolean; answerRecorded?: boolean; tabTools?: boolean }): Promise<PromptRun> {
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
  let text = ''
  let answered = false
  let stale: string | undefined
  // a replay sends the default answer only where the live run did
  const mayAnswer = (): boolean => opts.defaultAnswer !== false && !answered && (opts.client !== undefined || opts.answerRecorded === true)
  /** One message to mimir in the prompt's chat; returns the reply's text. */
  const turn = async (message: string): Promise<string> => {
    let reply = ''
    // the tool whose card is up: a card comes from the call that runs while it waits
    let running = ''
    for await (const ev of env.pilot.run(`creative-${p.id}`, message, { signal: ac.signal, context: { project: 'creative', machine: p.machine, objects: [] } })) {
      events.push(ev)
      if (ev.type === 'text') reply += ev.delta
      if (ev.type === 'tool_call') running = ev.tool
      noteApprovals(env.audit, ev)
      if (ev.type === 'approval_request') void env.pilot.resolveApproval(ev.request.id, isDesignTool(ev.request.tool) ? { kind: 'approve' } : { kind: 'deny', reason: 'not part of a design request' })
      if (ev.type === 'sheet') void env.pilot.answerSheet?.(ev.sheet.id, Object.fromEntries(ev.sheet.dims.map((d) => [d.key, d.value])))
      if (ev.type === 'ask') {
        const go = running === 'design.plan' ? ev.choices.find((c) => c.id.startsWith('go:')) : undefined
        if (go) void env.pilot.answer?.(ev.askId, go.id)
        else if (running === 'pilot.ask' && mayAnswer()) {
          answered = true
          void env.pilot.answer?.(ev.askId, null, DEFAULT_ANSWER)
        } else void env.pilot.answer?.(ev.askId, null)
      }
    }
    return reply
  }
  const built = (): boolean => events.some((e) => e.type === 'tool_call' && isDesignTool(e.tool))
  if (!opts.client && opts.tabTools !== true) stale = STALE_TOOLS
  try {
    text = await turn(p.prompt)
    if (!built() && classifyNoBuild(text) === 'asked' && opts.defaultAnswer !== false && !answered) {
      if (!opts.client && !opts.answerRecorded) stale ??= 'recorded before the default answer: the model asked a question, which a live run now answers once before scoring'
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
  const designCalls = calls.filter((c) => isDesignTool(c.tool))
  const last = designCalls.at(-1)
  // the last design call that did not go through, said in the tool's words when nothing was built
  const failed = designCalls.map((c) => ({ c, r: results.get(c.callId) })).filter(({ r }) => !r || r.ok === false).at(-1)
  // the designs with a body, as their objects in the project hold them
  const built3d = env.designs.list().filter((d) => d.parts.length)
  const parts: MeshPart[] = []
  for (const o of env.project.objects()) parts.push(...((await o.mesh?.()) ?? []))
  const featureSteps = built3d.reduce((n, d) => n + d.history.steps.length, 0)
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
  let parsed: Check
  if (!last) parsed = { pass: false, detail: `no design tool was called: ${noBuild ?? 'none'}${answered ? ', after the default answer' : ''}` }
  else if (!parts.length) parsed = { pass: false, detail: failed ? `${failed.c.tool}: ${failed.r?.summary ?? 'no result'}` : `${last.tool}: the design tools built no body` }
  else parsed = { pass: true, detail: `${plural(built3d.length, 'design')}, ${plural(featureSteps, 'feature step')}, ${plural(parts.length, 'mesh part')}` }
  const run: PromptRun = {
    parsed,
    parts,
    calls: calls.map((c) => c.tool),
    reply: events.map((e) => (e.type === 'text' ? e.delta : '')).join('').slice(0, 600),
    steps,
    answered,
  }
  if (noBuild) run.noBuild = noBuild
  if (p.mechanism && parts.length && opts.geom) {
    const geom = opts.geom
    try {
      run.gaps = await movingGaps(parts, (op, request) => geom.run(op, request))
    } catch (e) {
      error ??= `fit check: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  if (stale) run.stale = stale
  if (error) run.error = error
  return run
}
