// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A cloud model gets every tool with its full description, whatever a local model is sent, and the input schema
// without the keywords that say nothing (tool.ts, cloudToolDef). Each turn below calls for one toolset, or all of them,
// and its first request is built by the real provider adapter, as the app sends it. Every tool in the request body must
// have the full description the registry publishes (toolSpec) with every field description in it, no local
// description, and the lean schema: the same input, read the same way, in fewer tokens on every request.
import type { LlmHttpRequest, LlmTransport, PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv } from '../evals/harness'
import { createTransportClient } from '../src/provider/client'
import { decodeToolName } from '../src/provider/openai'
import { isLocalModel } from '../src/surfaces'
import { describedPaths } from '../src/local-schema'
import { cloudToolDef, toolSpec, type PilotTool } from '../src/tool'

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

/** Keywords a lean schema always leaves out, as they appear in a published one. */
const LEAN_DROPS: Record<string, RegExp> = {
  'safe integer bound': /"(?:maximum|minimum)":-?9007199254740991\b/g,
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
  it('sends every tool with its full description and the lean schema, for every toolset, scope and cloud provider', async () => {
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
            if (sent !== JSON.stringify(cloudToolDef(tool).parameters)) wrong.push(`${where}: schema is not the lean one`)
            // every field description of the published schema is there
            if (JSON.stringify(describedPaths(d.parameters)) !== JSON.stringify(describedPaths(spec.inputSchema))) wrong.push(`${where}: a field description is missing`)
            // and none of the keywords a lean schema always drops
            for (const [kind, re] of Object.entries(LEAN_DROPS)) {
              drops[kind]! += count(full, re)
              if (count(sent, re) > 0) wrong.push(`${where}: ${count(sent, re)} ${kind} keywords`)
            }
          }
        }
    expect(wrong, `cloud tool defs that are not the cloud form:\n${wrong.join('\n')}`).toEqual([])
    // the check has something to find: every kind of keyword a lean schema drops is in some full schema
    for (const [kind, n] of Object.entries(drops)) expect(n, kind).toBeGreaterThan(0)
  }, 60_000)
})
