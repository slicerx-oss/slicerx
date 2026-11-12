// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the mimir tab really sends a local model, measured with the runtime's own token counter (packages/pilot
// context.ts): the tab made as the app makes it, with the design tools and the app's built-in commands, and the request
// read back from the HTTP body the provider adapter wrote. Each kind of turn (a new part, shaping it, editing it, the
// app, the printers) fits a 16,384 token context with the whole system prompt, room for the reply and room for the
// conversation. A cloud model gets every tool on every turn, as before. Each prompt is pinned to its own text.
import { readFileSync } from 'node:fs'
import { HISTORY_VERSION } from '@slicerx/cad-history'
import type { Host, JsonSchema, LlmHttpRequest, LlmTransport, MeshHandle } from '@slicerx/contracts'
import { describedPaths, DETAIL_LINE, encodeToolName, FAMILY_LINE, FOLLOWUP_LINE, GENEROUS_LINE, LID_IN_PLACE, LID_PUT_ON, LOCAL_BUILD_CAP, LOCAL_TOOLS, localToolDef, messageTokens, MIMIR_CONTEXT, MOVING_PARTS_LINE, MOVING_PARTS_ORDER, type PilotTool, REPLY_RESERVE, RESHAPE_LINE, SIZES_ASK, SIZES_REPLY, surfaceTools, toolSpec, toolsTokens, TURN_SET_TOOL, VAGUE_LINE } from '@slicerx/pilot'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runCall } from '../src/app-link/methods'
import { builtinCommands } from '../src/commands/builtin'
import { registerCommands } from '../src/commands/registry'
import { NEUTRAL } from '../src/edition'
import { setupCommands } from '../src/first-run/look'
import { get, set, type PlateEntry } from '../src/state/store'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { hasDesign, resetTabMimir, tabMimir, tabTools } from '../src/workspaces/mimir/session'

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

/** The spelling rule every mimir prompt carries (packages/pilot prompt.ts). */
const AMERICAN = 'Write American spelling in replies, sheet rows and plan names (center, color, aluminum, gray, meter).'

/**
 * The whole system prompt each kind of model gets in the tab (rules, tabs line, playbooks and voice), kept beside the
 * prompts in packages/pilot. A change to the prompt text updates the file of each prompt it moves on purpose, and a
 * change to the local one also rechecks the budget below.
 */
const prompt = (file: string): string => readFileSync(new URL(`../../pilot/test/fixtures/${file}`, import.meta.url), 'utf8').replace(/\n$/, '')
const LOCAL_PROMPT = prompt('mimir-prompt-local.txt')
const CLOUD_PROMPT = prompt('mimir-prompt-cloud.txt')

/** Room a local model keeps for the conversation after the system prompt, the tools, the request and the reply. */
const CONVERSATION_ROOM = 1500

/**
 * What a build turn keeps spare beyond the conversation's room: a new part's turn sends the most tools, and the next
 * build tool or prompt line has to fit without cutting the reply or the conversation short.
 */
const BUILD_SPARE = 600

/**
 * Each build tool's required fields and enum values, by path (properties joined with dots, [] for an array's items).
 * A shorter description or schema text on a local turn never drops one of these; a tool may add more.
 */
const BUILD_PINS: Record<string, string[]> = {
  'design.new': ['name required'],
  'design.plan': ['assumptions required', 'features required', 'features.[].name required', 'features.[].sizes required', 'holes.[].diameter required', 'holes.[].name required', 'overall.x required', 'overall.y required', 'overall.z required', 'part required', 'questions required', 'units mm|in', 'units required'],
  'design.check': ['planId required'],
  'design.undo': ['design required'],
  'geom.extrude': ['distance_mm required', 'extent oneSide|symmetric|twoSides', 'extent required', 'operation new|join|cut', 'operation required', 'shape.align left|center|right', 'shape.diameterMm required', 'shape.fit inscribed|circumscribed', 'shape.heightMm required', 'shape.lengthMm required', 'shape.loops required', 'shape.sides required', 'shape.sizeMm required', 'shape.svg required', 'shape.text required', 'shape.type circle', 'shape.type polygon', 'shape.type rectangle', 'shape.type required', 'shape.type sketch', 'shape.type slot', 'shape.type svg', 'shape.type text', 'shape.widthMm required'],
  'geom.revolve': ['angle_deg required', 'axis required', 'axis.direction required', 'axis.point required', 'frame.normal required', 'frame.origin required', 'loops.[].center required', 'loops.[].diameterMm required', 'loops.[].points required', 'loops.[].segments required', 'loops.[].segments.[].type line|arc|spline', 'loops.[].segments.[].type required', 'loops.[].start required', 'loops.[].type circle', 'loops.[].type required', 'loops.[].type spline', 'operation new|join|cut', 'operation required'],
  'geom.loft': ['operation new|join|cut', 'operation required', 'profiles.[].loops required'],
  'geom.sweep': ['operation new|join|cut', 'operation required', 'profile.loops required'],
  'geom.hole': ['counterbore.depth_mm required', 'counterbore.diameter_mm required', 'countersink.angle_deg required', 'countersink.diameter_mm required', 'diameter_mm required', 'face.at required'],
  'geom.fillet': ['edges required', 'edges.[].a required', 'edges.[].b required', 'edges.[].face required', 'radius_mm required'],
  'geom.chamfer': ['distance_mm required', 'edges required', 'edges.[].a required', 'edges.[].b required', 'edges.[].face required'],
  'geom.shell': ['open required', 'open.[].at required', 'open.[].normal required', 'wall_mm required'],
  'geom.boolean': ['op required', 'op union|subtract|intersect'],
  'geom.info': [],
}

/** The rules a build tool's short local text must keep from its full text, word for word. */
const TWIN_RULES: Record<string, string[]> = {
  'geom.boolean': ['removes', 'keeps what they share'],
  // the feature tags, and for a print-in-place plan its pieces and gaps and the fit check that must run first
  'design.check': ['a step or more tagged with each planned feature', 'A plan with printInPlace also gets pieces', 'fit_check has run on the design as it is now', 'gap sizes in the plan too'],
  // the size kinds, and the gaps a print-in-place plan keeps, by the fit rule
  'design.plan': ['kinds', 'count or angle', 'keep the gaps where they meet at least', 'unless printInPlace is false'],
  'geom.chamfer': ["edge's own face", 'distance2_mm'],
  'geom.fillet': ['edge_pick'],
  'geom.hole': ['counterbore', 'countersink', 'flat face', 'geom.hole_edit'],
  'geom.shell': ['outward normal'],
}

/** The required fields and enum and const values of a schema, by path, as BUILD_PINS writes them. */
function pins(v: unknown, at = '', out = new Set<string>()): Set<string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  const o = v as Record<string, unknown>
  if (Array.isArray(o.required)) for (const r of o.required) out.add(`${at}${String(r)} required`)
  if (Array.isArray(o.enum)) out.add(`${at.replace(/\.$/, '')} ${o.enum.join('|')}`)
  if ('const' in o) out.add(`${at.replace(/\.$/, '')} ${String(o.const)}`)
  for (const [k, x] of Object.entries(o)) {
    if (k === 'properties' && x && typeof x === 'object') for (const [name, s] of Object.entries(x)) pins(s, `${at}${name}.`, out)
    else if (k === 'items' || k === 'additionalProperties') pins(x, `${at}[].`, out)
    else if (['anyOf', 'oneOf', 'allOf', 'prefixItems'].includes(k) && Array.isArray(x)) for (const s of x) pins(s, at, out)
  }
  return out
}

const LOCAL = { mode: 'on', provider: 'local', model: 'qwen3:8b-16k', baseUrl: 'http://127.0.0.1:11434/v1' } as const
const CLOUD = { mode: 'on', provider: 'anthropic' } as const

/**
 * Each kind of turn: the message, the message before it in the same chat when the kind follows from it, and whether a
 * design is on the plate (shaping needs one; with none, the same words start a part).
 */
const TURNS: { kind: string; before?: string; message: string; design?: true }[] = [
  { kind: 'build', message: 'A 30 mm cube with a fillet' },
  { kind: 'shape', before: 'A 30 mm cube with a fillet', message: 'Mirror it and add a pattern of four holes', design: true },
  { kind: 'edit', before: 'A 30 mm cube with a fillet', message: 'Make the base thicker' },
  { kind: 'app', message: 'Slice the plate and send it to my printer' },
  { kind: 'app', before: 'A wall hook for a 6 mm screw', message: 'What layer height and infill should I print it with?' },
  { kind: 'print', message: "How's my print going?" },
]

/** A design on the plate: an object with a history. */
const DESIGN: PlateEntry = { id: 'obj_cube', name: 'Cube', handle: handle('obj_cube'), parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], history: { version: HISTORY_VERSION, base: [], steps: [] } }

const hostWith = (llm: LlmTransport): Host => ({ kind: 'desktop', capabilities: { secureStorage: true }, slicer: { loadParts: async (n: string) => handle(n) }, build: { version: '0.0.0-test' }, llm }) as unknown as Host

/** The first request of `message`'s turn in a fresh chat, after `before` when given. */
async function turn(pref: typeof LOCAL | typeof CLOUD, message: string, before?: string, design?: boolean): Promise<LlmHttpRequest> {
  resetTabMimir()
  set({ pilot: pref, ...(design ? { plate: [DESIGN] } : {}) })
  const llm = transport()
  const pilot = await tabMimir(hostWith(llm), NEUTRAL)
  if (before) for await (const _ of pilot.run('s', before)) void _
  const at = llm.sent.length
  for await (const _ of pilot.run('s', message)) void _
  return llm.sent[at]!
}

describe('the mimir tab on a local model', () => {
  const was = { pilot: get().pilot, plate: get().plate }
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

  it.each(TURNS)('fits a $kind turn ($message) in the context with the whole system prompt', async ({ kind, message, before, design }) => {
    const local = await turn(LOCAL, message, before, design)
    // the turn sends the set it is named for
    if (kind === 'shape') expect(read(local).tools.map((t) => t.name)).toContain('geom__mirror')
    expect(local.url).toContain('127.0.0.1:11434')
    const c = cost(local)
    // the headroom in the failure message: what the turn uses, the limit and what is spare
    const used = c.total + REPLY_RESERVE + CONVERSATION_ROOM
    expect(used, `used ${used} of ${MIMIR_CONTEXT} tokens (system ${c.system}, messages ${c.messages}, ${c.count} tools ${c.tools}, the reply ${REPLY_RESERVE}, the conversation ${CONVERSATION_ROOM}), spare ${MIMIR_CONTEXT - used}`).toBeLessThanOrEqual(MIMIR_CONTEXT)
    if (kind === 'build') expect(MIMIR_CONTEXT - used, `a build turn keeps ${BUILD_SPARE} spare`).toBeGreaterThanOrEqual(BUILD_SPARE)
    // the system prompt goes whole and first: the one a cloud model gets, plus the line naming the registered tabs, less
    // the cloud-only line for parts that move and the plan line's pointer to it
    const cloud = read(await turn(CLOUD, message, before))
    const sent = read(local)
    expect(sent.messages[0]!.role).toBe('system')
    expect(sent.messages[0]!.content).toContain(TABS)
    // both prompts ask for American spelling, the local one in full
    expect(sent.messages[0]!.content).toContain(AMERICAN)
    expect(cloud.messages[0]!.content).toContain(AMERICAN)
    expect(cloud.messages[0]!.content).not.toContain(TABS)
    expect(cloud.messages[0]!.content).toContain(MOVING_PARTS_LINE)
    expect(sent.messages[0]!.content).not.toContain(MOVING_PARTS_LINE)
    expect(cloud.messages[0]!.content).toContain(MOVING_PARTS_ORDER)
    expect(sent.messages[0]!.content).not.toContain(MOVING_PARTS_ORDER)
    expect(cloud.messages[0]!.content).toContain(RESHAPE_LINE)
    expect(sent.messages[0]!.content).not.toContain(RESHAPE_LINE)
    expect(cloud.messages[0]!.content).toContain(FAMILY_LINE)
    expect(sent.messages[0]!.content).not.toContain(FAMILY_LINE)
    expect(cloud.messages[0]!.content).toContain(DETAIL_LINE)
    expect(sent.messages[0]!.content).not.toContain(DETAIL_LINE)
    // the follow-up line is on a turn that follows a built design (one on the plate), never on a first build's prompt
    if (design) expect(cloud.messages[0]!.content).toContain(FOLLOWUP_LINE)
    else expect(cloud.messages[0]!.content).not.toContain(FOLLOWUP_LINE)
    expect(sent.messages[0]!.content).not.toContain(FOLLOWUP_LINE)
    // a thing made of colored parts is built assembled: the cloud prompt says so, the local one has no room for it
    expect(cloud.messages[0]!.content).toContain('- A thing made of parts in different colors')
    expect(sent.messages[0]!.content).not.toContain('parts in different colors')
    expect(sent.messages[0]!.content.replace(`\n\n${TABS}`, '')).toBe(cloud.messages[0]!.content.replace(`\n${MOVING_PARTS_LINE}`, '').replace(`\n${RESHAPE_LINE}`, '').replace(`\n${FAMILY_LINE}`, '').replace(`\n${DETAIL_LINE}`, '').replace(`\n${FOLLOWUP_LINE}`, '').replace(`\n${GENEROUS_LINE}`, '').replace(`\n${VAGUE_LINE}`, '').replace(MOVING_PARTS_ORDER, '').replace(LID_IN_PLACE, '').replace(LID_PUT_ON, '').replace(SIZES_ASK, '').replace(SIZES_REPLY, '').replace(/\n- A thing made of parts in different colors[^\n]*/, ''))
    // each prompt is pinned to its own text, so a wording change that moves the local prompt, and its budget, is made on purpose
    expect(sent.messages[0]!.content, 'the local prompt (packages/pilot/test/fixtures/mimir-prompt-local.txt)').toBe(LOCAL_PROMPT)
    expect(cloud.messages[0]!.content.replace(`\n${FOLLOWUP_LINE}`, '').replace(`\n${GENEROUS_LINE}`, '').replace(`\n${VAGUE_LINE}`, ''), 'the cloud prompt (packages/pilot/test/fixtures/mimir-prompt-cloud.txt), less the follow-up line of a turn on a built design').toBe(CLOUD_PROMPT)
  })

  it('sends the design tools only on modeling turns and the app tools only on app turns', async () => {
    const tools = async (message: string, before?: string) => read(await turn(LOCAL, message, before)).tools.map((t) => t.name)
    const build = await tools('A 30 mm cube with a fillet')
    expect(build).toEqual(expect.arrayContaining(['design__new', 'design__plan', 'geom__extrude', 'geom__revolve', 'geom__loft', 'geom__sweep', 'geom__hole', 'geom__faces', 'pilot__sheet', 'pilot__tools']))
    // the fit check loads on demand: a new part's turn has no room for it beside the face list
    expect(build).not.toContain('geom__fit_check')
    // projecting edges into a sketch edits a part already built; a new part never starts with it
    expect(build).not.toContain('design__sketch_project')
    expect(await tools('Make the base thicker', 'A 30 mm cube with a fillet')).toContain('design__sketch_project')
    // saving a note is never a step of a new part, so its turn leaves it out; shaping and editing it keep it
    expect(build).not.toContain('memory__remember')
    expect(build).toContain('memory__recall')
    expect(await tools('Make the base thicker', 'A 30 mm cube with a fillet')).toContain('memory__remember')
    expect(build.some((n) => n.startsWith('app__') || n.startsWith('printer__') || n.startsWith('settings__'))).toBe(false)
    const app = await tools('Slice the plate and send it to my printer')
    expect(app).toEqual(expect.arrayContaining(['app__slice', 'printer__queue', 'settings__get', 'settings__apply', 'pilot__tools']))
    expect(app.some((n) => n.startsWith('geom__') || n.startsWith('design__'))).toBe(false)
    expect(app).not.toContain('printer__pause')
    const print = await tools("How's my print going?")
    expect(print).toEqual(expect.arrayContaining(['printer__status', 'printer__pause', 'printer__queue', 'pilot__tools']))
    expect(print.some((n) => n.startsWith('geom__') || n.startsWith('settings__'))).toBe(false)
  })

  it('keeps every required field and enum of the build tools, and points a shorter description at the knowledge base', async () => {
    const local = read(await turn(LOCAL, 'A 30 mm cube with a fillet')).tools
    const cloud = new Map(read(await turn(CLOUD, 'A 30 mm cube with a fillet')).tools.map((t) => [t.name, t]))
    const kb = await bundledKb()
    for (const [name, want] of Object.entries(BUILD_PINS)) {
      const t = local.find((x) => x.name === name.replace('.', '__'))
      expect(t, name).toBeDefined()
      const full = cloud.get(t!.name)!
      const got = pins(t!.parameters)
      expect(want.filter((p) => !got.has(p)), `${name} keeps its required fields and enums`).toEqual([])
      // the local form takes exactly what the cloud form takes
      expect([...got].sort(), name).toEqual([...pins(full.parameters)].sort())
      if (t!.description === full.description) continue
      expect(t!.description.length, name).toBeLessThan(full.description.length)
      // each required argument by name, as a word of its own
      for (const arg of (full.parameters as { required?: string[] }).required ?? []) expect(t!.description, `${name} names ${arg}`).toMatch(new RegExp(`(?<![\\w.])${arg}(?![\\w])`))
      // and the rules both texts must keep, so the short one cannot drift from the full one
      for (const rule of TWIN_RULES[name] ?? []) {
        expect(full.description, `${name}: the full text says "${rule}"`).toContain(rule)
        expect(t!.description, `${name}: the short text says "${rule}"`).toContain(rule)
      }
      // every shortened text points at the rest
      expect(t!.description, `${name} points at the knowledge base`).toMatch(/kb\.search "[^"]+"/)
      // a pointer to the rest names a search whose best entry is about this tool
      for (const [, query] of t!.description.matchAll(/kb\.search "([^"]+)"/g)) {
        const top = kb.search(query!)[0]?.doc
        expect(top?.id, `${name}: kb.search "${query}"`).toMatch(/^slicerx_/)
        expect(JSON.stringify(top?.data), `${name}: kb.search "${query}"`).toContain(name)
      }
    }
  })

  // New conversation keeps the plate, and a reload or a model change makes a new mimir over it: a design there is shaped
  // from the first turn of the chat, and once it is deleted the same words start a part
  it('shapes a design already on the plate in a new chat, and builds once it is gone', async () => {
    const tools = async (message: string) => read(await turn(LOCAL, message)).tools.map((t) => t.name)
    const model: PlateEntry = { id: 'obj_lid', name: 'Lid', handle: handle('obj_lid'), parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }
    try {
      set({ plate: [{ ...model, history: { version: HISTORY_VERSION, base: [], steps: [] } }] })
      const shaped = await tools('Make a circular pattern of six holes')
      expect(shaped).toEqual(expect.arrayContaining(['geom__array', 'geom__mirror']))
      expect(shaped).not.toContain('design__new')
      // an object with no history (an imported model) is not a design to shape
      set({ plate: [model] })
      expect(await tools('Make a circular pattern of six holes')).toContain('design__new')
    } finally {
      set({ plate: [] })
    }
    expect(await tools('Make a circular pattern of six holes')).toContain('design__new')
  })

  // a design that is still waiting for its first body (every extrude failed, or every step was undone) is no body on
  // the plate: a new chat, or a new project, starts a part
  it('builds in a new chat while a design is still waiting for its first body', async () => {
    resetTabMimir()
    set({ pilot: LOCAL, plate: [] })
    const llm = transport()
    const pilot = await tabMimir(hostWith(llm), NEUTRAL)
    const made = await tabTools().find((t) => t.name === 'design.new')!.run({ name: 'Desk lid' } as never, {} as never)
    expect(made.ok).not.toBe(false)
    expect(hasDesign()).toBe(false)
    const at = llm.sent.length
    for await (const _ of pilot.run('other', 'Make a circular pattern of six holes')) void _
    const sent = read(llm.sent[at]!).tools.map((t) => t.name)
    expect(sent).toContain('design__new')
    expect(sent).not.toContain('geom__array')
  })

  it('holds every tool the tab can send a local model to its row in LOCAL_TOOLS, and a new part turn to LOCAL_BUILD_CAP', async () => {
    const fix = 'raise or add its row in packages/pilot/src/local-tools.ts, in the same change'
    // every tool of every set, as a set switch (pilot.tools) can send any of them
    resetTabMimir()
    set({ pilot: LOCAL, plate: [DESIGN] })
    const pilot = (await tabMimir(hostWith(transport()), NEUTRAL)) as unknown as { registry(): PilotTool<never>[] }
    const over = surfaceTools('tab', true, pilot.registry())
      .map((t) => ({ name: t.name, cost: toolsTokens([{ ...localToolDef(t), name: encodeToolName(t.name) }]), row: LOCAL_TOOLS[t.name]?.tokens }))
      .filter((t) => t.row === undefined || t.cost > t.row)
    expect(over.map((t) => `${t.name} ${t.cost} (row ${t.row ?? 'none'})`), fix).toEqual([])
    // a row lists only field paths its tool still describes, and sends a description only for a tool without its own
    for (const t of surfaceTools('tab', true, pilot.registry())) {
      const shown = t.localInput ? { ...t, input: t.localInput } : t
      const described = new Set(describedPaths(toolSpec(shown as PilotTool<unknown>).inputSchema))
      expect((LOCAL_TOOLS[t.name]?.fields ?? []).filter((f) => !described.has(f)), t.name).toEqual([])
      if (t.localDescription !== undefined) expect(LOCAL_TOOLS[t.name]?.description, t.name).toBeUndefined()
    }
    // and as each kind of turn sends them
    for (const { kind, message, before, design } of TURNS) {
      const sent = read(await turn(LOCAL, message, before, design))
      for (const t of sent.tools) {
        const name = t.name.replace(/__/g, '.')
        expect(toolsTokens([t as never]), `${name} on a ${kind} turn: ${fix}`).toBeLessThanOrEqual(LOCAL_TOOLS[name]?.tokens ?? 0)
      }
      if (kind === 'build') expect(toolsTokens(sent.tools as never), 'the tools of a new part turn (LOCAL_BUILD_CAP in packages/pilot/src/local-tools.ts)').toBeLessThanOrEqual(LOCAL_BUILD_CAP)
    }
  })

  it('lists each set for clients, and every set together is every tool the tab offers', async () => {
    await turn(LOCAL, 'hello')
    const state = (await runCall('mimir.tab', {})) as { local: boolean; tools: string[]; turns: Record<string, string[]> }
    expect(state.local).toBe(true)
    expect(Object.keys(state.turns)).toEqual(['build', 'shape', 'edit', 'app', 'print'])
    expect(new Set(Object.values(state.turns).flat())).toEqual(new Set(state.tools))
    expect(state.turns.build).toEqual(expect.arrayContaining(['design.new', 'geom.extrude', 'geom.edge_pick', 'geom.faces', TURN_SET_TOOL]))
    // edge and face pickers serve both the first build and later edits
    expect(state.turns.edit).toEqual(expect.arrayContaining(['geom.edge_pick', 'geom.faces']))
    expect(state.turns.build).not.toContain('geom.fit_check')
    expect(state.turns.shape).toContain('geom.fit_check')
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
