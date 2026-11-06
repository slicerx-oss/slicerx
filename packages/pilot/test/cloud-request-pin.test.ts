// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A cloud model gets every tool in its full form, whatever a local model is sent. Each turn below calls for one
// toolset, or all of them, and its first request is built by the real provider adapter, as the app sends it. Every
// tool in the request body must have the full description and the full input schema the registry publishes (toolSpec),
// so no local description and no lean schema (tool.ts, localToolDef) ever reaches a cloud model.
import type { LlmHttpRequest, LlmTransport, PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv } from '../evals/harness'
import { createTransportClient } from '../src/provider/client'
import { decodeToolName } from '../src/provider/openai'
import { isLocalModel } from '../src/surfaces'
import { toolSpec, type PilotTool } from '../src/tool'

const MACHINE: PilotMachine = { printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }

/** A request for each toolset (toolsets.ts, the words turnNeeds reads), one with none, and one that calls for all. */
const TURNS: Record<string, string> = {
  none: 'hello',
  cad: 'Design a bracket',
  settings: 'Use more infill',
  printers: 'Send it to the printer',
  project: 'Save the project',
  kb: 'Why is it warping?',
  mesh: 'Repair the mesh',
  calibration: 'Calibrate the flow',
  fleets: 'Schedule the farm tonight',
  theme: 'Switch to dark mode',
  all: 'Why did my print fail? Design a part, repair the mesh, calibrate, slice and send it to the printer, schedule the farm after 6 pm, and save the project in dark mode',
}

/** Every cloud provider the runtime builds requests for. */
const CLOUD = ['anthropic', 'openai', 'mimir-cloud'] as const
const SCOPES = ['full', 'cad'] as const

/** The keywords a lean schema leaves out, as they appear in a published one. */
const LEAN_DROPS: Record<string, RegExp> = {
  'safe integer bound': /"(?:maximum|minimum)":-?9007199254740991\b/g,
  'closed object': /"additionalProperties":false/g,
  'any value': /"additionalProperties":\{\}/g,
  'string keys': /"propertyNames":\{"type":"string"\}/g,
}

/** A transport that keeps each request and answers none, so a turn ends after its first request. */
function transport(): LlmTransport & { sent: LlmHttpRequest[] } {
  const sent: LlmHttpRequest[] = []
  return {
    sent,
    available: async () => true,
    // eslint-disable-next-line require-yield
    async *stream(req) {
      sent.push(req)
      throw new Error('not answered in this test')
    },
  }
}

type Def = { name: string; description: string; parameters: unknown }

/** The tool definitions a request body carries, from either adapter's shape, by their own tool names. */
function toolDefs(req: LlmHttpRequest): Def[] {
  const body = JSON.parse(req.body) as { tools?: Record<string, unknown>[] }
  return (body.tools ?? [])
    .filter((t) => t['type'] === undefined || t['type'] === 'function')
    .map((t) => ({ name: decodeToolName(String(t['name'])), description: String(t['description']), parameters: t['input_schema'] ?? t['parameters'] }))
}

async function firstRequest(provider: string, scope: (typeof SCOPES)[number], message: string): Promise<{ req: LlmHttpRequest; registry: Map<string, PilotTool<never>> }> {
  const llm = transport()
  const client = createTransportClient(llm, provider)
  const env = createEvalEnv({ client, machine: MACHINE, objects: [], scope, model: 'pinned-model' })
  for await (const _ of env.pilot.run('t', message, { context: { machine: MACHINE } })) void _
  const req = llm.sent[0]
  if (!req) throw new Error(`no request for ${provider} ${scope} ${message}`)
  return { req, registry: new Map((env.pilot.registry() as PilotTool<never>[]).map((t) => [t.name, t])) }
}

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0

describe('a cloud model request', () => {
  it('sends every tool in full, with no local description or lean schema, for every toolset, scope and cloud provider', async () => {
    for (const provider of CLOUD) expect(isLocalModel({ provider })).toBe(false)
    const wrong: string[] = []
    const drops: Record<string, number> = Object.fromEntries(Object.keys(LEAN_DROPS).map((k) => [k, 0]))
    for (const provider of CLOUD)
      for (const scope of SCOPES)
        for (const [turn, message] of Object.entries(TURNS)) {
          const { req, registry } = await firstRequest(provider, scope, message)
          const defs = toolDefs(req)
          if (defs.length === 0) wrong.push(`${provider} ${scope} ${turn}: no tools`)
          for (const d of defs) {
            const where = `${provider} ${scope} ${turn} ${d.name}`
            const tool = registry.get(d.name)
            if (!tool) {
              wrong.push(`${where}: not in the registry`)
              continue
            }
            const spec = toolSpec(tool)
            if (d.description !== spec.description) wrong.push(`${where}: description is not the full one`)
            if (tool.localDescription !== undefined && d.description.includes(tool.localDescription)) wrong.push(`${where}: carries the local description`)
            const sent = JSON.stringify(d.parameters)
            const full = JSON.stringify(spec.inputSchema)
            if (sent !== full) wrong.push(`${where}: schema is not the full one`)
            // every keyword a lean schema drops is there, as often as the full schema has it
            for (const [kind, re] of Object.entries(LEAN_DROPS)) {
              const n = count(full, re)
              drops[kind]! += n
              if (count(sent, re) !== n) wrong.push(`${where}: ${count(sent, re)} of ${n} ${kind} keywords`)
            }
          }
        }
    expect(wrong, `cloud tool defs that are not the full form:\n${wrong.join('\n')}`).toEqual([])
    // the check has something to find: every kind of keyword a lean schema drops is in some full schema
    for (const [kind, n] of Object.entries(drops)) expect(n, kind).toBeGreaterThan(0)
  }, 60_000)
})
