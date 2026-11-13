// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs one creative prompt through the whole mimir loop (a recorded reply, or a live model when the caller passes
// one) on the mimir tab's tools, with the geometry engine as the host, then scores the last design it built.
import { bakeMesh, movedBy, type Design, type EngineCall } from '@slicerx/cad-history'
import { historyPart } from '@slicerx/cad-history/mesh-part'
import type { Bed, CommandSpec, MeshPart, PilotEvent, PilotMachine } from '@slicerx/contracts'
import { neutralEdition, type EditionConfig } from '@slicerx/edition-config'
import { modelById } from '@slicerx/printer-catalog'
import printerModels from '@slicerx/settings/printer-models.json' with { type: 'json' }
import { PLAN_LEFT_CODE, SAME_PART, type LlmClient, type LlmMessage, type ToolHost } from '@slicerx/pilot'
import { assessFit, createEvalEnv, createScriptedClient, noteApprovals, type EvalHosts, type ScriptStepData } from '@slicerx/pilot/evals'
import { defaultFilament, listFilaments, type FilamentSetup } from '../../src/filaments'
import { createCardPlans, createPlanRegistry, tabToolset, type FilamentList } from '../../src/toolset'
import { headlessDesignHost, plainBed } from './design-host'
import { bedFit, bodyCount, closure, minWall, movingGaps, type BuildVolume, type GapReport } from './mesh-checks'
import type { CreativePrompt } from './prompts'
import { createReplayCheck, replayRequests, toolResultsSeen, type RecordedStep } from './replay-divergence'

/** The tab's design tools (design.* and geom.*), the one way it builds a part. */
export const isDesignTool = (name: string): boolean => name.startsWith('design.') || name.startsWith('geom.')

/** The design tools that only read or plan: the plan card, the check and the reads of a design or a face. */
const DESIGN_READS = new Set(['design.plan', 'design.check', 'design.list', 'design.steps', 'design.timeline', 'design.put_plan', 'geom.info', 'geom.faces', 'geom.face_pick', 'geom.edge_pick', 'geom.measure', 'geom.sketch_check', 'geom.sketch_edit', 'geom.sketch_solve'])
/** Design tools that change no body: a new design starts empty, a finished sketch is not a body, a save writes a file. */
const NO_BODY = new Set(['design.new', 'design.sketch', 'design.save'])

/**
 * A call that adds or changes geometry: any design tool but a read, a plan or one that makes no body. A reply that
 * makes none built nothing, however much it planned or read, and a question it then asks gets the default answer.
 */
export const isBuildCall = (name: string): boolean => isDesignTool(name) && !DESIGN_READS.has(name) && !NO_BODY.has(name)

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
 * Scores the parts a run produced against the prompt's expectations (runPrompt hands it the last design's parts).
 * `parsed` false fails the run on its own. `gaps` are the gaps the engine measured between the bodies (movingGaps), for
 * a mechanism's clearance.
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
const designParts = (d: Design): MeshPart[] => d.parts.map((m) => historyPart(bakeMesh(m, movedBy(d.transform, d.placed))))

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
  const designs = headlessDesignHost(engine, { changed, bed: (id) => plainBed(bed, () => designs.list().filter((d) => d.id !== id && d.parts.length).map((d) => ({ parts: d.parts, transform: movedBy(d.transform, d.placed) }))) })
  let plans = 0
  const tools = tabToolset(designs, createCardPlans(createPlanRegistry()), { nozzleMm: () => p.machine.nozzle, newPlanId: () => `plan_${++plans}`, filaments: evalFilaments(designs), exactByDefault: false })
  const env = createEvalEnv({ client, machine: p.machine, objects: [], hosts: () => hosts, tools, tab: { slices: tab.slices, edition: tab.edition ?? CREATIVE_TAB.edition, ...(tab.commands ? { commands: [...tab.commands] } : {}) } })
  project = env.project
  return { ...env, designs, tools }
}

/**
 * Why a reply built nothing. `declined`: it says the part can't be modeled or built (often offering a simpler version
 * and asking which one; the refusal wins). `asked`: it does not decline, and puts a question to the person (a sentence
 * ending in a question mark). `stopped`: it got what it asked for (its plan approved, or the eval's answer) and then
 * ended without building, neither declining nor asking again, often saying what it would build next. `none`: none of
 * these, such as an empty reply, a statement, or a reply cut off.
 */
export type NoBuild = 'asked' | 'declined' | 'stopped' | 'none'

const DECLINES = /\b(?:can(?:'|\u2019|no)t|cannot|unable to|not able to)\s+(?:\w+\s+){0,3}?(?:model|build|make|design|sculpt)\b|\boutside what (?:I|the tools?) can\b|\btools? (?:can(?:'|\u2019|no)t|cannot|only)\b/i
const ASKS = /\?[)"'\u201d\u2019*_]*(?:\s|$)/

/**
 * Why `reply` built nothing. `after` is what it said after its plan was approved or the eval answered it, when either
 * happened: only that part counts then, so an offer of a simpler version it was then told to build is not a refusal.
 */
export function classifyNoBuild(reply: string, after?: string): NoBuild {
  const said = after ?? reply
  if (DECLINES.test(said)) return 'declined'
  if (ASKS.test(said)) return 'asked'
  return after === undefined ? 'none' : 'stopped'
}

/** What the eval says, once, when the model asks a question instead of building. */
export const DEFAULT_ANSWER = 'Use common sizes and sensible defaults, then build it'

export interface PromptRun {
  parsed: Check
  /** The last design's parts: the one a reply that built more than one design ends on, and the one that is scored. */
  parts: MeshPart[]
  calls: string[]
  reply: string
  /** What the model sent back, one step per provider request (for --record). */
  steps: RecordedStep[]
  /** Why nothing was built, when no call added or changed geometry. */
  noBuild?: NoBuild
  /** For a mechanism with parts and an engine: the gaps between its bodies, as the engine's fit check measures them. */
  gaps?: GapReport
  /** The model asked (in its reply, or with pilot.ask), and the eval gave it the default answer. */
  answered: boolean
  /** mimir went on once with the plan approved in the run unfinished (the plan_left note); a live capture stamps it. */
  planGoesOn?: true
  /** Why the recording no longer stands for what a live run would do (replay only). */
  stale?: string
  error?: string
}

/** Why a recording from before the eval ran on the tab's tools is stale. */
export const STALE_TOOLS = 'recorded before the eval had the tab\'s design tools (it called text_to_part or no tool), so a live run captures it again on design.* and geom.*'

/**
 * Why a recording whose reply starts the same part again is stale: it was captured before mimir refused a second
 * design.new for the part a reply already started, so the replay meets a refusal the model never saw and its later steps
 * go to a design that was never made.
 */
export const STALE_RESTART = 'recorded before mimir refused a design.new that starts the same part again (same_part): the replay met that refusal, so a live run captures it again'

/**
 * Why a recording that gets mimir's note about an unfinished plan is stale: it was captured before mimir went on with a
 * plan approved in the run (plan_left), so the replay sends a note the model never answered, and what follows is not
 * what a live run would do.
 */
export const STALE_PLAN_GOES_ON = 'recorded before mimir went on with an approved plan it had not finished (plan_left): the replay got that note, which the model never answered, so a live run captures it again'

/**
 * Whether a replay's run counts toward the score. A recording that got the plan_left note it was never captured with
 * stands for no reply of the model's, so it is listed as stale and left out, never scored as a failure. Other stale
 * recordings are scored as before.
 */
export function replayScored(run: Pick<PromptRun, 'stale'>): boolean {
  return run.stale !== STALE_PLAN_GOES_ON
}

/** Whether a request carries mimir's refusal of a design.new that starts the reply's part again. */
function restartRefused(messages: readonly LlmMessage[]): boolean {
  return messages.some((m) => {
    if (m.role !== 'tool') return false
    try {
      const out = JSON.parse(m.content) as { blocked?: unknown; code?: unknown }
      return out.blocked === true && out.code === SAME_PART
    } catch {
      return false
    }
  })
}

/**
 * One prompt through mimir on the tab's tools. `client` is the live model; without it the recorded steps replay.
 * The eval stands in for the person: a design tool's approval is given, anything else is denied; a plan card gets Go,
 * a dimension sheet is confirmed as shown, and a question card (pilot.ask) gets the default answer as the person's own
 * words, once; any other card is dismissed. When the reply builds nothing and asks a question, the eval answers once
 * with DEFAULT_ANSWER and lets the model go on (`defaultAnswer`, on unless false; the card and the reply share the one
 * answer). A replay answers only when the recording was captured with the answer (`answerRecorded`); a recorded
 * question without it is marked stale, and so is a recording from before the tab's tools (`tabTools` unset) and one whose
 * reply met the refusal of a restarted part though it was captured before that refusal (STALE_RESTART, `samePart` unset),
 * or got the note that its approved plan is unfinished though it was captured before that note (STALE_PLAN_GOES_ON,
 * `planGoesOn` unset). A run that ends early says why in `error`: an error the chat showed, the step cap, or a cancel
 * the eval did not ask for; so does a replay that leaves recorded replies unused. The eval never records such a run.
 */
export async function runPrompt(p: CreativePrompt, opts: { geom: ToolHost['geom']; steps?: ScriptStepData[]; client?: LlmClient; timeoutMs?: number; defaultAnswer?: boolean; answerRecorded?: boolean; tabTools?: boolean; samePart?: boolean; planGoesOn?: boolean; before?: (env: ReturnType<typeof creativeEnv>) => Promise<void> }): Promise<PromptRun> {
  const script = opts.client ? undefined : createScriptedClient(opts.steps ?? [], { chunk: false })
  const inner = opts.client ?? script!
  const steps: ScriptStepData[] = []
  // a replay compares the tool results it gets with the ones its recording saw (recordings made before they were kept skip it)
  const replayCheck = createReplayCheck()
  const replayed = replayRequests(opts.steps ?? [], replayCheck)
  // a replay that met the refusal of a restarted part: the recording's later steps no longer stand for a live run
  let restarted = false
  // Records each request's reply as a step, the shape the scripted client replays.
  const client: LlmClient = {
    provider: inner.provider,
    async *stream(req, signal) {
      // a recording captured since the refusal (samePart) saw it live, so meeting it again is the recorded reply
      if (!opts.client && opts.samePart !== true && restartRefused(req.messages)) restarted = true
      // a replay that no longer gets the results its recording saw ends here, saying where
      const diverged = opts.client ? undefined : replayed(req)
      if (diverged) {
        yield { type: 'text', delta: diverged }
        yield { type: 'done', stop: 'end' }
        return
      }
      const seen = toolResultsSeen(req.messages)
      const step: RecordedStep = seen.length ? { seen } : {}
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
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? (opts.client ? 300_000 : 60_000))
  // every geometry call carries the prompt's deadline, also the ones that read the parts back after the run
  const engine = opts.geom
  const geom: ToolHost['geom'] = engine && { run: (op, input, signal) => engine.run(op, input, signal ? AbortSignal.any([signal, ac.signal]) : ac.signal) }
  const env = creativeEnv(p, client, geom ? { geom } : {})
  // what was on the plate before the prompt's message, such as a part an earlier message built (tests)
  await opts.before?.(env)
  const events: PilotEvent[] = []
  let error: string | undefined
  let text = ''
  let answered = false
  let stale: string | undefined
  // what the reply said since its plan was approved or the eval answered it; undefined while neither has happened
  let after: string | undefined
  // why the run ended early, said by the pilot: an error it showed, the step cap, or a cancel the eval did not ask for
  let ended: string | undefined
  // a replay sends the default answer only where the live run did
  const mayAnswer = (): boolean => opts.defaultAnswer !== false && !answered && (opts.client !== undefined || opts.answerRecorded === true)
  /** One message to mimir in the prompt's chat; returns the reply's text. */
  const turn = async (message: string): Promise<string> => {
    let reply = ''
    // the tool whose card is up: a card comes from the call that runs while it waits
    let running = ''
    for await (const ev of env.pilot.run(`creative-${p.id}`, message, { signal: ac.signal, context: { project: 'creative', machine: p.machine, objects: [] } })) {
      events.push(ev)
      // a notice that mimir waits or goes on (waiting) is not an error
      if (ev.type === 'error' && !ev.waiting && ev.code !== PLAN_LEFT_CODE) ended ??= `the run ended on an error: ${ev.message}`
      if (ev.type === 'done') {
        if (ev.stopReason === 'error') ended ??= 'the run ended on an error'
        else if (ev.stopReason === 'max_steps') ended ??= 'the run stopped at the step cap'
        else if (ev.stopReason === 'canceled' && !ac.signal.aborted) ended ??= 'the run was canceled'
      }
      if (ev.type === 'text') {
        reply += ev.delta
        if (after !== undefined) after += ev.delta
      }
      if (ev.type === 'tool_call') running = ev.tool
      noteApprovals(env.audit, ev)
      if (ev.type === 'approval_request') void env.pilot.resolveApproval(ev.request.id, isDesignTool(ev.request.tool) ? { kind: 'approve' } : { kind: 'deny', reason: 'not part of a design request' })
      if (ev.type === 'sheet') void env.pilot.answerSheet?.(ev.sheet.id, Object.fromEntries(ev.sheet.dims.map((d) => [d.key, d.value])))
      if (ev.type === 'ask') {
        const go = running === 'design.plan' ? ev.choices.find((c) => c.id.startsWith('go:')) : undefined
        if (go) {
          after = ''
          void env.pilot.answer?.(ev.askId, go.id)
        } else if (running === 'pilot.ask' && mayAnswer()) {
          answered = true
          after = ''
          void env.pilot.answer?.(ev.askId, null, DEFAULT_ANSWER)
        } else void env.pilot.answer?.(ev.askId, null)
      }
    }
    return reply
  }
  const built = (): boolean => events.some((e) => e.type === 'tool_call' && isBuildCall(e.tool))
  if (!opts.client && opts.tabTools !== true) stale = STALE_TOOLS
  try {
    text = await turn(p.prompt)
    if (!built() && classifyNoBuild(text, after) === 'asked' && opts.defaultAnswer !== false && !answered) {
      if (!opts.client && !opts.answerRecorded) stale ??= 'recorded before the default answer: the model asked a question, which a live run now answers once before scoring'
      else {
        answered = true
        after = ''
        text = await turn(DEFAULT_ANSWER)
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  // the designs with a body, as their objects in the project hold them. A reply that builds a design again as a new one
  // (a second try after a failed check) leaves the first on the plate too; the last design is the answer it gives, so
  // that one alone is scored, as a person would print it.
  const built3d = env.designs.list().filter((d) => d.parts.length)
  const scored = built3d.at(-1)
  const parts: MeshPart[] = []
  try {
    for (const o of env.project.objects()) if (o.id === scored?.id) parts.push(...((await o.mesh?.()) ?? []))
  } catch (e) {
    error ??= e instanceof Error ? e.message : String(e)
  } finally {
    clearTimeout(timer)
  }
  error ??= ended
  // a replay that ends before its recorded replies do no longer follows what the model did live
  const left = script?.remaining() ?? 0
  if (left > 0) error ??= `the replay left ${left} recorded repl${left === 1 ? 'y' : 'ies'} unused`
  const noBuild = built() ? undefined : classifyNoBuild(text, after)
  const calls = events.filter((e): e is Extract<PilotEvent, { type: 'tool_call' }> => e.type === 'tool_call')
  const results = new Map(events.filter((e): e is Extract<PilotEvent, { type: 'tool_result' }> => e.type === 'tool_result').map((r) => [r.callId, r]))
  const designCalls = calls.filter((c) => isDesignTool(c.tool))
  const last = designCalls.at(-1)
  // the last design call that did not go through, said in the tool's words when nothing was built
  const failed = designCalls.map((c) => ({ c, r: results.get(c.callId) })).filter(({ r }) => !r || r.ok === false).at(-1)
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
  const builtLine = (d: Design): string => `${plural(d.history.steps.length, 'feature step')}, ${plural(parts.length, 'mesh part')}`
  let parsed: Check
  if (!last) parsed = { pass: false, detail: `no design tool was called: ${noBuild ?? 'none'}${answered ? ', after the default answer' : ''}` }
  else if (!parts.length || !scored) parsed = { pass: false, detail: failed ? `${failed.c.tool}: ${failed.r?.detail ?? failed.r?.summary ?? 'no result'}` : `${last.tool}: the design tools built no body` }
  else parsed = { pass: true, detail: built3d.length === 1 ? `1 design, ${builtLine(scored)}` : `${plural(built3d.length, 'design')}, scored the last (${scored.id}): ${builtLine(scored)}` }
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
  if (restarted) stale ??= STALE_RESTART
  // mimir went on with its unfinished plan: a live capture stamps it, and a replay captured without the stamp is stale
  if (events.some((e) => e.type === 'error' && e.code === PLAN_LEFT_CODE)) {
    run.planGoesOn = true
    if (!opts.client && opts.planGoesOn !== true) stale ??= STALE_PLAN_GOES_ON
  }
  if (stale) run.stale = stale
  // a replay whose tool results stopped matching the recording's says where, ahead of whatever that led to
  if (replayCheck.diverged) error = replayCheck.diverged
  if (error) run.error = error
  return run
}

/**
 * The project's filaments as the app's rail counts them: those set, and as many more as the highest filament a design's
 * part prints in, each PLA in the default color for its number until set.
 */
function evalFilaments(designs: { list(): readonly Pick<Design, 'parts'>[] }): FilamentList {
  const setup: Record<number, FilamentSetup> = {}
  const list = () => {
    const set = listFilaments(setup, 'PLA')
    const used = Math.max(set.length, ...designs.list().flatMap((d) => d.parts.map((part) => part.slot)))
    return Array.from({ length: used }, (_, i) => {
      const f = set[i] ?? { slot: i + 1, ...defaultFilament(i + 1, 'PLA') }
      return { slot: i + 1, type: f.type, color: f.color }
    })
  }
  return {
    list,
    add: (slot, patch) => void (setup[slot] = { ...defaultFilament(slot, 'PLA'), ...patch }),
    set: (slot, patch) => {
      const cur = list()[slot - 1] ?? { ...defaultFilament(slot, 'PLA') }
      setup[slot] = { type: patch.type ?? cur.type, color: patch.color ?? cur.color }
    },
  }
}
