// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The tools a model is offered by where mimir runs: a local model gets its surface's own set, a cloud model every
// tool, and the system prompt never names a tool the model was not given.
import type { PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv } from '../evals/harness'
import { createScriptedClient, type ScriptStep } from '../src/provider/scripted'
import type { LlmRequest } from '../src/provider/types'
import { isLocalModel, surfaceTools, type ToolSurface } from '../src/surfaces'

const MACHINE: PilotMachine = { printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }

/** Every surface and scope a mimir runs with today. A surface added later adds its rows here. */
const SURFACES: { surface: ToolSurface; scope: 'full' | 'cad' }[] = [
  { surface: 'dock', scope: 'full' },
  { surface: 'dock', scope: 'cad' },
]
const PATHS = [
  { path: 'local', provider: 'openai-compatible' },
  { path: 'cloud', provider: 'anthropic' },
] as const

async function firstRequest(provider: string, scope: 'full' | 'cad', steps: ScriptStep[] = [{ text: 'ok' }]): Promise<{ req: LlmRequest; registry: string[]; events: { type: string; summary?: string }[] }> {
  const client = createScriptedClient(steps, { provider })
  const env = createEvalEnv({ client, machine: MACHINE, objects: [], scope })
  const events: { type: string; summary?: string }[] = []
  for await (const e of env.pilot.run('t', 'make a 40 mm cube', { context: { machine: MACHINE } })) events.push(e as { type: string; summary?: string })
  const req = client.requests[0]
  if (!req) throw new Error('no request')
  return { req, registry: env.pilot.registry().map((t) => t.name), events }
}

describe('picking the tools by surface', () => {
  const tools = ['kb.search', 'text_to_part', 'make_model', 'slice', 'printer.status'].map((name) => ({ name }))

  it('gives a cloud model every tool, in order', () => {
    expect(surfaceTools('dock', false, tools)).toEqual(tools)
  })

  it('gives a local model in the dock its chat tools and text_to_part, without make_model', () => {
    expect(surfaceTools('dock', true, tools).map((t) => t.name)).toEqual(['kb.search', 'text_to_part', 'slice', 'printer.status'])
  })

  it('counts only the OpenAI-compatible local server as a local model', () => {
    expect(isLocalModel({ provider: 'openai-compatible' })).toBe(true)
    for (const provider of ['openai', 'anthropic', 'mimir-cloud', 'scripted']) expect(isLocalModel({ provider })).toBe(false)
  })
})

describe.each(SURFACES)('the $surface surface ($scope)', ({ scope }) => {
  it('offers a local model everything but make_model, and a cloud model everything', async () => {
    const local = await firstRequest('openai-compatible', scope)
    const cloud = await firstRequest('anthropic', scope)
    const localNames = local.req.tools.map((t) => t.name)
    const cloudNames = cloud.req.tools.map((t) => t.name)
    expect(cloudNames).toContain('make_model')
    expect(cloudNames).toEqual(cloud.registry)
    expect(localNames).toContain('text_to_part')
    expect(localNames).not.toContain('make_model')
    expect(localNames).toEqual(cloudNames.filter((n) => n !== 'make_model'))
  })

  it.each(PATHS)('names in its $path prompt only tools that session has', async ({ provider }) => {
    const { req, registry } = await firstRequest(provider, scope)
    // every tool any mimir has, so a name the prompt mentions is caught whichever list it was left out of
    const known = new Set([...registry, ...(await firstRequest('anthropic', 'full')).registry])
    const offered = new Set(req.tools.map((t) => t.name))
    const system = req.messages[0]?.content ?? ''
    // only names that cannot be ordinary words ("slice" and "orient" are also prose)
    const named = [...known].filter((n) => /[._]/.test(n) && new RegExp(`(^|[^\\w.])${n.replace(/\./g, '\\.')}(?![\\w])`).test(system))
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((n) => !offered.has(n))).toEqual([])
  })

  it('keeps the multi-color line for a cloud model only', async () => {
    const local = (await firstRequest('openai-compatible', scope)).req.messages[0]?.content ?? ''
    const cloud = (await firstRequest('anthropic', scope)).req.messages[0]?.content ?? ''
    expect(cloud).toContain('text_to_part (make_model for a multi-color model)')
    expect(local).toContain('goes straight to text_to_part, not to the knowledge base')
    expect(local).not.toMatch(/make_model/)
  })

  it('answers a local model that calls a tool it was not offered as an unknown tool, and runs nothing', async () => {
    const { events } = await firstRequest('openai-compatible', scope, [{ calls: [{ name: 'make_model', args: { prompt: 'a cube' } }] }, { text: 'ok' }])
    const result = events.find((e) => e.type === 'tool_result')
    expect(result?.summary).toBe('Unknown tool make_model')
  })
})
