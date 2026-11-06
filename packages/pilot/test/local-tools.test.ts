// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The form of each tool a local model gets (tool.ts, localToolDef), for every tool this package defines: the schema
// loses only keywords that say nothing, so the tool takes and checks the same input as before.
import type { PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEvalEnv } from '../evals/harness'
import type { MemoryStore } from '../src/memory/facts'
import { createScriptedClient } from '../src/provider/scripted'
import { surfaceTools } from '../src/surfaces'
import { defineTool, localToolDef, toolSpec, type PilotTool } from '../src/tool'
import { askTool, lookupTool, sheetBindTool, sheetTool } from '../src/tools/ask'
import { memoryTools } from '../src/tools/memory'
import { turnSetTool } from '../src/turnsets'

const MACHINE: PilotMachine = { printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }

/**
 * Every tool this package defines that a local model can be sent: the builtins and skills, the printer plugins' tools,
 * the chat's own and the notes, less the ones the tab never offers a local model (surfaces.ts).
 */
async function everyTool(): Promise<PilotTool<never>[]> {
  const client = createScriptedClient([{ text: 'done' }], { provider: 'openai-compatible' })
  const env = createEvalEnv({ client, machine: MACHINE, objects: [], scope: 'full' })
  // the first run loads the printer plugins' tools
  for await (const _ of env.pilot.run('t', 'hello', { context: { machine: MACHINE } })) void _
  const own = [askTool(), lookupTool(), sheetTool(), sheetBindTool(), turnSetTool(() => undefined), ...memoryTools({} as MemoryStore)]
  const byName = new Map<string, PilotTool<never>>()
  for (const t of [...(env.pilot.registry() as PilotTool<never>[]), ...own]) byName.set(t.name, t)
  return surfaceTools('tab', true, [...byName.values()])
}

/** The keyword paths of a schema, such as properties.plate.minimum. */
function paths(v: unknown, at = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => paths(x, `${at}[${i}]`))
  if (v === null || typeof v !== 'object') return [`${at}=${JSON.stringify(v)}`]
  return Object.entries(v).flatMap(([k, x]) => [`${at}.${k}`, ...paths(x, `${at}.${k}`)])
}

describe('the local form of every tool', () => {
  it('drops only keywords that say nothing from the schema, and keeps a strict object closed', async () => {
    for (const t of await everyTool()) {
      const full = new Set(paths(toolSpec(t).inputSchema))
      const local = paths(localToolDef(t).parameters)
      // nothing new and nothing changed: every local keyword and value is in the published schema
      expect(local.filter((p) => !full.has(p)), t.name).toEqual([])
      expect(JSON.stringify(localToolDef(t).parameters), t.name).not.toContain(String(Number.MAX_SAFE_INTEGER))
    }
    const probe = defineTool({
      name: 'test.probe',
      version: '1.0.0',
      source: 'plugin',
      permission: 'read',
      description: 'Probe.',
      input: z.object({ n: z.number().int().optional(), open: z.object({ a: z.string() }), shut: z.strictObject({ b: z.boolean().optional() }), any: z.looseObject({}), map: z.record(z.string(), z.number()), list: z.array(z.string()).default([]) }),
      async run() {
        return { summary: 'ok' }
      },
    }) as PilotTool<never>
    expect(localToolDef(probe).parameters).toEqual({
      type: 'object',
      properties: {
        n: { type: 'integer' },
        open: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        shut: { type: 'object', properties: { b: { type: 'boolean' } }, additionalProperties: false },
        any: { type: 'object', properties: {} },
        map: { type: 'object', additionalProperties: { type: 'number' } },
        list: { default: [], type: 'array', items: { type: 'string' } },
      },
      required: ['open', 'shut', 'any', 'map', 'list'],
    })
    // the published schema is as it was: closed objects and the safe integer range
    expect(toolSpec(probe).inputSchema).toMatchObject({ additionalProperties: false, properties: { n: { maximum: Number.MAX_SAFE_INTEGER }, open: { additionalProperties: false } } })
  })
})
