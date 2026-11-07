// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs one creative prompt through the whole mimir loop (a recorded reply, or a live model when the caller passes
// one) with the geometry engine as the host, then scores the parts it added to the project.
import type { MeshPart, PilotEvent, PilotMachine } from '@slicerx/contracts'
import { modelById } from '@slicerx/printer-catalog'
import printerModels from '@slicerx/settings/printer-models.json' with { type: 'json' }
import { assessFit } from '../../skills/fit_check/index'
import { createScriptedClient, type ScriptStepData } from '../../src/provider/scripted'
import type { LlmClient } from '../../src/provider/types'
import type { ToolHost } from '../../src/tool'
import { createEvalEnv, noteApprovals } from '../harness'
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

export interface PromptRun {
  parsed: Check
  parts: MeshPart[]
  calls: string[]
  reply: string
  /** What the model sent back, one step per provider request (for --record). */
  steps: ScriptStepData[]
  error?: string
}

/**
 * One prompt through mimir. `client` is the live model; without it the recorded steps replay. Design tools are
 * approved as the person would; anything else is denied.
 */
export async function runPrompt(p: CreativePrompt, opts: { geom: ToolHost['geom']; steps?: ScriptStepData[]; client?: LlmClient; timeoutMs?: number }): Promise<PromptRun> {
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
  const hosts = () => (opts.geom ? { geom: opts.geom } : {})
  const env = createEvalEnv({ client, machine: p.machine, objects: [], hosts })
  const events: PilotEvent[] = []
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? (opts.client ? 300_000 : 60_000))
  let error: string | undefined
  try {
    for await (const ev of env.pilot.run(`creative-${p.id}`, p.prompt, { signal: ac.signal, context: { project: 'creative', machine: p.machine, objects: [] } })) {
      events.push(ev)
      noteApprovals(env.audit, ev)
      if (ev.type === 'approval_request') void env.pilot.resolveApproval(ev.request.id, MODEL_TOOLS.has(ev.request.tool) ? { kind: 'approve' } : { kind: 'deny', reason: 'not part of a design request' })
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  } finally {
    clearTimeout(timer)
  }
  const calls = events.filter((e): e is Extract<PilotEvent, { type: 'tool_call' }> => e.type === 'tool_call')
  const results = new Map(events.filter((e): e is Extract<PilotEvent, { type: 'tool_result' }> => e.type === 'tool_result').map((r) => [r.callId, r]))
  const modelCalls = calls.filter((c) => MODEL_TOOLS.has(c.tool))
  const last = modelCalls.at(-1)
  const lastResult = last ? results.get(last.callId) : undefined
  const parts: MeshPart[] = []
  for (const o of env.project.objects()) parts.push(...((await o.mesh?.()) ?? []))
  let parsed: Check
  if (!last) parsed = { pass: false, detail: 'no design tool was called' }
  else if (!lastResult || lastResult.ok === false) parsed = { pass: false, detail: `${last.tool}: ${lastResult?.summary ?? 'no result'}` }
  else if (!parts.length) parsed = { pass: false, detail: `${last.tool} added no parts` }
  else parsed = { pass: true, detail: `${last.tool}, ${parts.length} mesh part${parts.length === 1 ? '' : 's'}` }
  const run: PromptRun = {
    parsed,
    parts,
    calls: calls.map((c) => c.tool),
    reply: events.map((e) => (e.type === 'text' ? e.delta : '')).join('').slice(0, 600),
    steps,
  }
  if (error) run.error = error
  return run
}
