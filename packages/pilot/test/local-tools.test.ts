// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The form of each tool a local model gets (tool.ts, localToolDef), for every tool this package defines. Its
// description stays within a per-tool cap, so a new or longer tool cannot quietly eat the room context.test.ts keeps for
// the conversation; a shorter local description still names the tool's required arguments; and the schema loses only
// keywords that say nothing, and writes a tuple of one kind (a point) as the plain array it equals, so the tool takes and
// checks the same input as before.
import type { PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEvalEnv } from '../evals/harness'
import { estimateTokens, toolsTokens } from '../src/context'
import { describedPaths, keepDescriptions } from '../src/local-schema'
import { LOCAL_TOOLS } from '../src/local-tools'
import type { MemoryStore } from '../src/memory/facts'
import { encodeToolName } from '../src/provider/openai'
import { createScriptedClient } from '../src/provider/scripted'
import { surfaceTools } from '../src/surfaces'
import { defineTool, localToolDef, toolSpec, type PilotTool } from '../src/tool'
import { askTool, lookupTool, sheetBindTool, sheetTool } from '../src/tools/ask'
import { memoryTools } from '../src/tools/memory'
import { turnSetTool } from '../src/turnsets'

const MACHINE: PilotMachine = { printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }

/**
 * The most a tool's local description may cost, in tokens at the rate toolsTokens (context.ts) counts tool schemas.
 * 160 is about 720 characters: room for what the tool does, its required arguments and its rules, with the longest
 * today (printer_setup, which has to carry the rule about access codes) just inside. Every local turn pays for every
 * description it sends, so a tool over this gets a localDescription instead of raising the cap.
 */
const LOCAL_DESCRIPTION_CAP = 160

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

const tokens = (text: string): number => estimateTokens(text, 4.5)

/** `v` with each tuple whose places all take one schema written as `items` that schema, as the local form writes it. */
function plainTuples(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plainTuples)
  if (v === null || typeof v !== 'object') return v
  const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainTuples(x)]))
  const p = o.prefixItems
  if (!Array.isArray(p) || !p.length || o.items !== false || o.minItems !== p.length || o.maxItems !== p.length || p.some((x) => JSON.stringify(x) !== JSON.stringify(p[0]))) return o
  const { prefixItems: _p, items: _i, ...rest } = o
  return { ...rest, items: p[0] }
}

/** The keyword paths of a schema, such as properties.plate.minimum. */
function paths(v: unknown, at = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => paths(x, `${at}[${i}]`))
  if (v === null || typeof v !== 'object') return [`${at}=${JSON.stringify(v)}`]
  return Object.entries(v).flatMap(([k, x]) => [`${at}.${k}`, ...paths(x, `${at}.${k}`)])
}

describe('the local form of every tool', () => {
  it(`keeps each description within ${LOCAL_DESCRIPTION_CAP} tokens`, async () => {
    const tools = await everyTool()
    expect(tools.length).toBeGreaterThan(60)
    const over = tools.map((t) => ({ name: t.name, tokens: tokens(localToolDef(t).description) })).filter((t) => t.tokens > LOCAL_DESCRIPTION_CAP)
    expect(over, `over the ${LOCAL_DESCRIPTION_CAP} token cap (give each a shorter localDescription): ${over.map((t) => `${t.name} ${t.tokens}`).join(', ')}`).toEqual([])
  })

  it('names every required argument in a shorter local description, and is shorter than the full one', async () => {
    const short = (await everyTool()).filter((t) => t.localDescription !== undefined)
    expect(short.map((t) => t.name).sort()).toEqual(['arrange', 'pilot.ask', 'pilot.sheet', 'pilot.tools', 'printer.status', 'printer_add', 'printer_setup', 'schedule', 'text_to_part'])
    for (const t of short) {
      expect(t.localDescription!.length, t.name).toBeLessThan(t.description.length)
      for (const arg of toolSpec(t).inputSchema.required ?? []) expect(t.localDescription, `${t.name} names ${arg}`).toContain(arg)
    }
  })

  it('drops only keywords that say nothing from the schema, and keeps a strict object closed', async () => {
    for (const t of await everyTool()) {
      const full = new Set(paths(plainTuples(toolSpec(t).inputSchema)))
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
      input: z.object({ n: z.number().int().optional(), open: z.object({ a: z.string() }), id: z.string().min(1).optional(), title: z.string().min(2).max(60).optional(), shut: z.strictObject({ b: z.boolean().optional() }), any: z.looseObject({}), map: z.record(z.string(), z.number()), list: z.array(z.string()).default([]), point: z.tuple([z.number(), z.number()]), pair: z.tuple([z.string(), z.number()]), kind: z.literal('box'), side: z.enum(['left', 'right']) }),
      async run() {
        return { summary: 'ok' }
      },
    }) as PilotTool<never>
    expect(localToolDef(probe).parameters).toEqual({
      type: 'object',
      properties: {
        n: { type: 'integer' },
        open: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        // a string that is not empty says nothing a model needs; a longer floor and a ceiling stay
        id: { type: 'string' },
        title: { type: 'string', minLength: 2, maxLength: 60 },
        shut: { type: 'object', properties: { b: { type: 'boolean' } }, additionalProperties: false },
        any: { type: 'object', properties: {} },
        map: { type: 'object', additionalProperties: { type: 'number' } },
        list: { default: [], type: 'array', items: { type: 'string' } },
        // a point takes the same two numbers written as a plain array; a tuple of mixed places stays a tuple
        point: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
        pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], items: false, minItems: 2, maxItems: 2 },
        // a const is the one value taken, so the type beside it says nothing
        kind: { const: 'box' },
        // and an enum of strings lists every value taken, so its string type says nothing either
        side: { enum: ['left', 'right'] },
      },
      required: ['open', 'shut', 'any', 'map', 'list', 'point', 'pair', 'kind', 'side'],
    })
    // the published schema is as it was: closed objects and the safe integer range
    expect(toolSpec(probe).inputSchema).toMatchObject({ additionalProperties: false, properties: { n: { maximum: Number.MAX_SAFE_INTEGER }, open: { additionalProperties: false }, id: { minLength: 1 } } })
  })
})

describe('a local input', () => {
  it('shows a local model the fields of localInput, while the tool still takes and checks its whole input', async () => {
    const t = defineTool({
      name: 'test.local_input',
      version: '1.0.0',
      description: 'A tool with a field only cloud models are told of.',
      source: 'command',
      permission: 'read',
      input: z.object({ part: z.string(), amends: z.string().optional() }),
      localInput: z.object({ part: z.string() }),
      async run(i) {
        return { summary: i.amends ? `amends ${i.amends}` : 'new' }
      },
    })
    expect(Object.keys((localToolDef(t).parameters as { properties: object }).properties)).toEqual(['part'])
    expect(Object.keys((toolSpec(t).inputSchema as { properties: object }).properties)).toEqual(['part', 'amends'])
    expect((await t.run(t.input.parse({ part: 'Box', amends: 'p1' }), {} as never)).summary).toBe('amends p1')
  })
})

describe('the text a local model is sent', () => {
  it('holds every tool this package can send a local model to its row in LOCAL_TOOLS (local-tools.ts)', async () => {
    const over = (await everyTool())
      .map((t) => ({ name: t.name, cost: toolsTokens([{ ...localToolDef(t), name: encodeToolName(t.name) }]), row: LOCAL_TOOLS[t.name]?.tokens }))
      .filter((t) => t.row === undefined || t.cost > t.row)
    expect(over.map((t) => `${t.name} ${t.cost} (row ${t.row ?? 'none'})`), 'raise or add its row in local-tools.ts, in the same change').toEqual([])
  })

  it('lists in each row only field paths its tool still describes, and a description only for a tool without its own', async () => {
    // a tool made in more than one form (pilot.ask with sizes, as the app makes it) may describe a path in either
    const described = new Map<string, Set<string>>()
    const tools = [...(await everyTool()), askTool({ sizesOnSheet: true })]
    for (const t of tools) {
      const shown = t.localInput ? { ...t, input: t.localInput } : t
      for (const p of describedPaths(toolSpec(shown as PilotTool<unknown>).inputSchema)) described.set(t.name, (described.get(t.name) ?? new Set()).add(p))
    }
    for (const t of tools) {
      const row = LOCAL_TOOLS[t.name]!
      expect((row.fields ?? []).filter((p) => !described.get(t.name)?.has(p)), t.name).toEqual([])
      if (t.localDescription !== undefined) expect(row.description, t.name).toBeUndefined()
    }
  })

  it('sends a local model no description and no field description of a tool with no row, while a cloud model gets both', () => {
    const t = defineTool({
      name: 'test.unlisted',
      version: '1.0.0',
      description: 'A tool added for cloud models.',
      source: 'command',
      permission: 'read',
      input: z.object({ part: z.string().describe('The part') }),
      async run() {
        return { summary: 'ok' }
      },
    })
    expect(localToolDef(t)).toEqual({ name: 'test.unlisted', description: '', parameters: { type: 'object', properties: { part: { type: 'string' } }, required: ['part'] } })
    expect(toolSpec(t).description).toBe('A tool added for cloud models.')
    expect(toolSpec(t).inputSchema).toMatchObject({ properties: { part: { description: 'The part' } } })
  })

  it("keeps only the field descriptions a tool's row lists: a field added later reaches cloud turns only", () => {
    // kb.search's row sends its description and none of its field descriptions
    const t = defineTool({
      name: 'kb.search',
      version: '1.0.0',
      description: 'Search the knowledge base.',
      source: 'command',
      permission: 'read',
      input: z.object({ query: z.string(), later: z.string().optional().describe('A field added for cloud models') }),
      async run() {
        return { summary: 'ok' }
      },
    })
    expect(LOCAL_TOOLS['kb.search']).toEqual({ tokens: 88, description: true })
    expect(localToolDef(t).description).toBe('Search the knowledge base.')
    expect(describedPaths(localToolDef(t).parameters)).toEqual([])
    expect(describedPaths(toolSpec(t).inputSchema)).toEqual(['later'])
  })

  it('writes each described field as a path: properties by name, [] for items, {} for map values, a union at its own path', () => {
    const schema = {
      description: 'root',
      properties: {
        shape: { anyOf: [{ properties: { kind: { description: 'a' } } }, { properties: { kind: { description: 'b' }, r: { description: 'c' } } }] },
        rows: { items: { properties: { at: { description: 'd' } } } },
        tags: { additionalProperties: { description: 'e' } },
      },
    }
    expect(describedPaths(schema)).toEqual(['', 'rows[].at', 'shape.kind', 'shape.r', 'tags{}'])
    expect(describedPaths(keepDescriptions(schema, new Set(['shape.kind'])))).toEqual(['shape.kind'])
    // the copy is new: the schema given is left as it was
    expect(describedPaths(schema)).toHaveLength(5)
  })
})
