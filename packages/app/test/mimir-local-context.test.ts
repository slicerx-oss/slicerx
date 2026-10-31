// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the mimir tab really sends a local model, measured with the runtime's own token counter (packages/pilot
// context.ts): the tab made as the app makes it, with the design tools and the app's built-in commands, and the request
// read back from the HTTP body the provider adapter wrote. Each kind of turn (a new part, shaping it, editing it, the
// app, the printers) fits a 16,384 token context with the whole system prompt, room for the reply and room for the
// conversation. A cloud model gets every tool on every turn, as before.
import type { Host, JsonSchema, LlmHttpRequest, LlmTransport, MeshHandle } from '@slicerx/contracts'
import { messageTokens, MIMIR_CONTEXT, REPLY_RESERVE, toolsTokens, TURN_SET_TOOL } from '@slicerx/pilot'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runCall } from '../src/app-link/methods'
import { builtinCommands } from '../src/commands/builtin'
import { registerCommands } from '../src/commands/registry'
import { NEUTRAL } from '../src/edition'
import { setupCommands } from '../src/first-run/look'
import { get, set } from '../src/state/store'
import { resetTabMimir, tabMimir } from '../src/workspaces/mimir/session'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })

/** A transport that keeps each request and answers none of them, so every turn ends after its first request. */
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

type Def = { name: string; description: string; parameters: JsonSchema }
type Msg = { role: string; content: string }

/** A request's messages and tool definitions as the runtime counted them, from either provider's body. */
function read(req: LlmHttpRequest): { messages: Msg[]; tools: Def[] } {
  const b = JSON.parse(req.body) as {
    system?: string | { text: string }[]
    messages: { role: string; content: string | { type: string; text?: string }[] }[]
    tools?: ({ function: { name: string; description: string; parameters: JsonSchema } } | { name: string; description: string; input_schema: JsonSchema })[]
  }
  const text = (c: string | { text?: string }[]): string => (typeof c === 'string' ? c : c.map((x) => x.text ?? '').join(''))
  const system = b.system === undefined ? [] : [{ role: 'system', content: text(b.system) }]
  const tools = (b.tools ?? []).map((t) => ('function' in t ? { name: t.function.name, description: t.function.description, parameters: t.function.parameters } : { name: t.name, description: t.description, parameters: t.input_schema }))
  return { messages: [...system, ...b.messages.map((m) => ({ role: m.role, content: text(m.content) }))], tools }
}

/** Tokens a request costs, by the runtime's own count: the system prompt, the rest of the messages and the tools. */
function cost(req: LlmHttpRequest): { system: number; messages: number; tools: number; total: number; count: number } {
  const { messages, tools } = read(req)
  const system = messageTokens(messages[0] as never)
  const rest = messages.slice(1).reduce((a, m) => a + messageTokens(m as never), 0)
  const t = toolsTokens(tools)
  return { system, messages: rest, tools: t, total: system + rest + t, count: tools.length }
}

/** The tabs line for the tabs registered below: the plate's modes, then Slice, My models and Printers. */
const TABS = 'The app has these tabs: mimir (this chat), Model, Slice, My models and Printers. Name no other tab.'

/** Room a local model keeps for the conversation after the system prompt, the tools, the request and the reply. */
const CONVERSATION_ROOM = 1500

const LOCAL = { mode: 'on', provider: 'local', model: 'qwen3:8b-16k', baseUrl: 'http://127.0.0.1:11434/v1' } as const
const CLOUD = { mode: 'on', provider: 'anthropic' } as const

/** Each kind of turn: the message, and the message before it in the same chat when the kind follows from it. */
const TURNS: { kind: string; before?: string; message: string }[] = [
  { kind: 'build', message: 'A 30 mm cube with a fillet' },
  { kind: 'shape', before: 'A 30 mm cube with a fillet', message: 'Mirror it and add a pattern of four holes' },
  { kind: 'edit', before: 'A 30 mm cube with a fillet', message: 'Make the base thicker' },
  { kind: 'app', message: 'Slice the plate and send it to my printer' },
  { kind: 'app', before: 'A wall hook for a 6 mm screw', message: 'What layer height and infill should I print it with?' },
  { kind: 'print', message: "How's my print going?" },
]

const hostWith = (llm: LlmTransport): Host => ({ kind: 'desktop', capabilities: { secureStorage: true }, slicer: { loadParts: async (n: string) => handle(n) }, build: { version: '0.0.0-test' }, llm }) as unknown as Host

/** The first request of `message`'s turn in a fresh chat, after `before` when given. */
async function turn(pref: typeof LOCAL | typeof CLOUD, message: string, before?: string): Promise<LlmHttpRequest> {
  resetTabMimir()
  set({ pilot: pref })
  const llm = transport()
  const pilot = await tabMimir(hostWith(llm), NEUTRAL)
  if (before) for await (const _ of pilot.run('s', before)) void _
  const at = llm.sent.length
  for await (const _ of pilot.run('s', message)) void _
  return llm.sent[at]!
}

describe('the mimir tab on a local model', () => {
  const was = { pilot: get().pilot }
  let off: () => void = () => undefined
  beforeAll(() => {
    // the commands the app registers at startup (app.tsx): the built-in ones over the default tabs, and the setup ones
    const workspaces = [
      { id: 'prepare', label: 'Slice' },
      { id: 'library', label: 'My models' },
      { id: 'printers', label: 'Printers' },
    ]
    off = registerCommands([...builtinCommands({ kind: 'desktop' } as unknown as Host, workspaces), ...setupCommands()])
  })
  afterEach(() => {
    resetTabMimir()
    set(was)
  })
  afterAll(() => off())

  it.each(TURNS)('fits a $kind turn ($message) in the context with the whole system prompt', async ({ message, before }) => {
    const local = await turn(LOCAL, message, before)
    expect(local.url).toContain('127.0.0.1:11434')
    const c = cost(local)
    expect(c.total + REPLY_RESERVE + CONVERSATION_ROOM).toBeLessThanOrEqual(MIMIR_CONTEXT)
    // the system prompt goes whole and first: the one a cloud model gets, plus the line naming the registered tabs
    const cloud = read(await turn(CLOUD, message, before))
    const sent = read(local)
    expect(sent.messages[0]!.role).toBe('system')
    expect(sent.messages[0]!.content).toContain(TABS)
    expect(cloud.messages[0]!.content).not.toContain(TABS)
    expect(sent.messages[0]!.content.replace(`\n\n${TABS}`, '')).toBe(cloud.messages[0]!.content)
  })

  it('sends the design tools only on modeling turns and the app tools only on app turns', async () => {
    const tools = async (message: string, before?: string) => read(await turn(LOCAL, message, before)).tools.map((t) => t.name)
    const build = await tools('A 30 mm cube with a fillet')
    expect(build).toEqual(expect.arrayContaining(['design__new', 'geom__extrude', 'pilot__sheet', 'pilot__tools']))
    expect(build.some((n) => n.startsWith('app__') || n.startsWith('printer__') || n.startsWith('settings__'))).toBe(false)
    const app = await tools('Slice the plate and send it to my printer')
    expect(app).toEqual(expect.arrayContaining(['app__slice', 'printer__queue', 'settings__apply', 'pilot__tools']))
    expect(app.some((n) => n.startsWith('geom__') || n.startsWith('design__'))).toBe(false)
    expect(app).not.toContain('printer__pause')
    const print = await tools("How's my print going?")
    expect(print).toEqual(expect.arrayContaining(['printer__status', 'printer__pause', 'printer__queue', 'pilot__tools']))
    expect(print.some((n) => n.startsWith('geom__') || n.startsWith('settings__'))).toBe(false)
  })

  it('lists each set for clients, and every set together is every tool the tab offers', async () => {
    await turn(LOCAL, 'hello')
    const state = (await runCall('mimir.tab', {})) as { local: boolean; tools: string[]; turns: Record<string, string[]> }
    expect(state.local).toBe(true)
    expect(Object.keys(state.turns)).toEqual(['build', 'shape', 'edit', 'app', 'print'])
    expect(new Set(Object.values(state.turns).flat())).toEqual(new Set(state.tools))
    expect(state.turns.build).toEqual(expect.arrayContaining(['design.new', 'geom.extrude', TURN_SET_TOOL]))
    expect(state.turns.app).toEqual(expect.arrayContaining(['app.slice', 'printer.queue', TURN_SET_TOOL]))
    expect(state.turns.app).not.toContain('geom.extrude')
  })
})

describe('the mimir tab on a cloud model', () => {
  const was = { pilot: get().pilot }
  afterEach(() => {
    resetTabMimir()
    set(was)
  })

  it('sends every tool on every turn, in the same order, with no set to pick', async () => {
    const first = read(await turn(CLOUD, 'A 30 mm cube with a fillet')).tools.map((t) => t.name)
    for (const { message, before } of TURNS) expect(read(await turn(CLOUD, message, before)).tools.map((t) => t.name)).toEqual(first)
    expect(first).toEqual(expect.arrayContaining(['design__new', 'geom__mirror', 'design__timeline', 'printer__queue', 'settings__apply']))
    expect(first).not.toContain('pilot__tools')
    expect(((await runCall('mimir.tab', {})) as { turns: unknown }).turns).toBeNull()
  })
})
