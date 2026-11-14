// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// No mimir tab request loads more than 128 tools. OpenAI-style APIs and local servers refuse a longer list, and so does
// mimir cloud's proxy for the tools that load up front (supabase/functions/mimir/shape.ts). Once the proxy has said it
// takes tool search (the event its streams open with), a new chat on mimir cloud carries the tab's whole catalog, most
// of it deferred behind tool search; a proxy that never said so gets the per-turn pick it always got. The tab is made
// the way the app makes it, with the commands the app registers at startup, its features' commands, a command per
// connected printer and every connector's tools, and each request is read back from the HTTP body the provider adapter
// wrote. Every kind of turn is checked in the desktop app (which slices and prints) and the browser build (which only
// models), on mimir cloud before and after its proxy takes tool search, a key and a local model, in the neutral edition
// and in one with the printer and web tools off. Last, a recorded chat's requests go through the proxy's own shape():
// the same tools on every request.
import type { EditionConfig } from '@slicerx/edition-config'
import type { Host, LlmHttpRequest, LlmTransport, MeshHandle, PluginManifest, PrinterHost, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { MIMIR_CLOUD_MAX_TOOLS, SEARCH_CORE } from '@slicerx/pilot'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { builtinCommands } from '../src/commands/builtin'
import { registerCommands } from '../src/commands/registry'
import { NEUTRAL } from '../src/edition'
import { cloudFeature } from '../src/features/cloud/index'
import { fleetFeature } from '../src/features/fleet/index'
import { pilotFeature } from '../src/features/pilot/index'
import { storeFeature } from '../src/features/store/index'
import { setupCommands } from '../src/first-run/look'
import { registerMimirCloud } from '../src/pilot-connect/cloud'
import { setHostSlices } from '../src/state/model-mode'
import { get, set } from '../src/state/store'
import { resetTabMimir, tabMimir } from '../src/workspaces/mimir/session'
import { MAX_LOADED_TOOLS, MAX_TOOLS, shape, TOOL_CHANGES_BETA } from '../../../supabase/functions/mimir/shape'

/** The most tools any provider mimir runs on here takes in one request. */
const CAP = 128

/** Every connector the printer bridge can list, experimental ones too (the most tools it can add). */
const CONNECTORS = JSON.parse(readFileSync(new URL('../../connect/manifests.json', import.meta.url), 'utf8')) as PluginManifest[]

/** A busy fleet: each printer prints, so each one adds its send and pause commands. */
const FLEET = Array.from({ length: 12 }, (_, i) => ({ id: `p${i + 1}`, name: `Printer ${i + 1}`, vendor: 'Prusa', model: 'MK4', plugin: 'prusalink', nozzleCount: 1 }) as PrinterInfo)
const printers = {
  list: async () => FLEET,
  plugins: async () => CONNECTORS,
  fleets: async () => [],
  status: async () => ({ state: 'printing', cameraAvailable: true }) as unknown as PrinterStatus,
  subscribe: () => () => undefined,
} as unknown as PrinterHost

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })

/** The event mimir cloud's proxy opens each stream with once it takes tool search (supabase/functions/mimir/handler.ts). */
const PROXY_SAYS = (() => {
  const src = readFileSync(new URL('../../../supabase/functions/mimir/handler.ts', import.meta.url), 'utf8')
  const lit = /export const TOOL_SEARCH_EVENT = ('[^']*')/.exec(src)?.[1]
  if (!lit) throw new Error('no TOOL_SEARCH_EVENT in the proxy')
  return JSON.parse(`"${lit.slice(1, -1).replaceAll('"', '\\"')}"`) as string
})()

/**
 * A transport that keeps each request and answers none of them, so every turn ends after its first request. `proxy`:
 * a mimir cloud proxy that takes tool search, so each answer opens with its event before it fails.
 */
function transport(proxy = false): LlmTransport & { sent: LlmHttpRequest[] } {
  const sent: LlmHttpRequest[] = []
  return {
    sent,
    available: async () => true,
    async *stream(req) {
      sent.push(req)
      if (proxy) yield new TextEncoder().encode(PROXY_SAYS)
      throw new Error('not answered in this test')
    },
  }
}

type Platform = 'desktop' | 'web'
const hostFor = (kind: Platform, llm: LlmTransport): Host => ({ kind, capabilities: { secureStorage: true }, slicer: { loadParts: async (n: string) => handle(n) }, printers, build: { version: '0.0.0-test' }, llm }) as unknown as Host

/** The edition with mimir cloud on (its proxy is the edition's Supabase project). */
const withCloud = (e: EditionConfig): EditionConfig => ({ ...e, ai: { ...e.ai, keySource: 'cloud' }, backend: { ...e.backend, supabase: { url: 'https://abcdefghijklmnop.supabase.co', anonKey: 'public-anon-key-from-the-supabase-dashboard' } } })
/** The edition with its printer and web tools switched off in its brain pack. */
const toolsOff = (e: EditionConfig): EditionConfig => ({ ...e, id: `${e.id}-tools-off`, ai: { ...e.ai, brain: { ...e.ai.brain, tools: { ...(e.ai.brain.tools ?? {}), printers: false, web: false } } } })

const EDITIONS: [string, EditionConfig][] = [
  ['neutral', NEUTRAL],
  ['printers and web off', toolsOff(NEUTRAL)],
]

/**
 * How mimir runs: mimir cloud on a proxy that never said it takes tool search (deployed before it), mimir cloud once its
 * proxy has said so, a key on an OpenAI-style API, and a local model.
 */
const MODES = {
  'mimir cloud': { mode: 'on', provider: 'mimir-cloud' },
  'mimir cloud, tool search': { mode: 'on', provider: 'mimir-cloud' },
  'openai key': { mode: 'on', provider: 'openai' },
  local: { mode: 'on', provider: 'local', model: 'qwen3:8b-16k', baseUrl: 'http://127.0.0.1:11434/v1' },
} as const
type Mode = keyof typeof MODES

/** Each kind of turn: the message, and the message before it in the same chat when the kind follows from it. */
const TURNS: { kind: string; before?: string; message: string }[] = [
  { kind: 'build', message: 'A 30 mm cube with a fillet' },
  { kind: 'shape', before: 'A 30 mm cube with a fillet', message: 'Mirror it and add a pattern of four holes' },
  { kind: 'edit', before: 'A 30 mm cube with a fillet', message: 'Make the base thicker' },
  { kind: 'app', message: 'Slice the plate and send it to my printer' },
  { kind: 'print', message: "How's my print going?" },
  { kind: 'chat', message: 'hello' },
]

/** The proxy's rule for a tool name (shape.ts). */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

/** A request's tool names, from either provider's body. */
function toolNames(req: LlmHttpRequest): string[] {
  const b = JSON.parse(req.body) as { tools?: Record<string, unknown>[] }
  return (b.tools ?? []).map((t) => String((t['function'] as { name?: string } | undefined)?.name ?? t['name'] ?? ''))
}

/** The tools a request loads up front: every one but those deferred behind tool search. */
function loadedNames(req: LlmHttpRequest): string[] {
  const b = JSON.parse(req.body) as { tools?: Record<string, unknown>[] }
  return (b.tools ?? []).filter((t) => t['defer_loading'] !== true).map((t) => String((t['function'] as { name?: string } | undefined)?.name ?? t['name'] ?? ''))
}

/** The tool search tool a mimir cloud request carries (packages/pilot, provider/anthropic.ts). */
const SEARCH = 'tool_search_tool_bm25'

/**
 * The first request of a turn in a fresh chat, after `before` when given, and how many tools the tab offers. With tool
 * search, a first chat has heard the proxy say it takes it.
 */
async function turn(platform: Platform, edition: EditionConfig, mode: Mode, t: (typeof TURNS)[number]): Promise<{ req: LlmHttpRequest; offered: number }> {
  resetTabMimir()
  set({ pilot: MODES[mode] as never })
  const searching = mode === 'mimir cloud, tool search'
  const llm = transport(searching)
  const cloud = MODES[mode].provider === 'mimir-cloud'
  const pilot = await tabMimir(hostFor(platform, llm), cloud ? withCloud(edition) : edition, cloud ? 'cloud' : null)
  if (searching) for await (const _ of pilot.run('warm', 'hello')) void _
  if (t.before) for await (const _ of pilot.run('s', t.before)) void _
  const at = llm.sent.length
  for await (const _ of pilot.run('s', t.message)) void _
  const req = llm.sent[at]
  if (!req) throw new Error(`no request for the ${t.kind} turn on ${platform}, ${mode}`)
  return { req, offered: pilot.tools().length }
}

const WORKSPACES = [
  { id: 'prepare', label: 'Slice' },
  { id: 'library', label: 'My models' },
  { id: 'printers', label: 'Printers' },
]

/** Registers what the app registers at startup on `platform` (app.tsx): the built-in, setup and feature commands. */
async function registerApp(platform: Platform): Promise<() => void> {
  setHostSlices(platform === 'desktop')
  const host = hostFor(platform, transport())
  const off = registerCommands([...builtinCommands(host, WORKSPACES), ...setupCommands(), ...[storeFeature, fleetFeature, pilotFeature, cloudFeature].flatMap((f) => f.commands?.(host) ?? [])])
  // the fleet's per-printer commands register once each printer's status is read
  await new Promise((r) => setTimeout(r, 20))
  return off
}

describe('no mimir tab request loads more than 128 tools', () => {
  const was = { pilot: get().pilot }
  beforeAll(() => registerMimirCloud({ quota: async () => { throw new Error('not read here') }, forget: async () => 0, register: async () => undefined }))
  afterAll(() => {
    resetTabMimir()
    registerMimirCloud(null)
    setHostSlices(true)
    set(was)
  })

  it('holds mimir cloud to the limit its proxy takes', () => {
    expect(MIMIR_CLOUD_MAX_TOOLS).toBe(CAP)
    expect(MAX_LOADED_TOOLS).toBe(CAP)
  })

  for (const platform of ['desktop', 'web'] as const) {
    it(`loads at most ${CAP} tools on every turn in the ${platform === 'desktop' ? 'desktop app' : 'browser build'}`, async () => {
      const off = await registerApp(platform)
      try {
        const over: string[] = []
        const badNames: string[] = []
        let most = 0
        for (const [ename, edition] of EDITIONS)
          for (const mode of Object.keys(MODES) as Mode[])
            for (const t of TURNS) {
              const { req, offered } = await turn(platform, edition, mode, t)
              const names = toolNames(req)
              const loaded = loadedNames(req)
              most = Math.max(most, offered)
              if (loaded.length > CAP) over.push(`${t.kind} turn, ${ename}, ${mode}: ${loaded.length} tools`)
              if (MODES[mode].provider === 'mimir-cloud') badNames.push(...names.filter((n) => !TOOL_NAME.test(n)))
              // the whole catalog and the search tool, under the proxy's cap
              if (mode === 'mimir cloud, tool search') {
                if (names.length !== offered + 1 || names.length > MAX_TOOLS) over.push(`${t.kind} turn, ${ename}, ${mode}: ${names.length} of ${offered} tools in all`)
              } else if (names.length > CAP) over.push(`${t.kind} turn, ${ename}, ${mode}: ${names.length} tools in all`)
            }
        expect(over, `requests over ${CAP} tools`).toEqual([])
        expect(badNames, 'tool names mimir cloud refuses').toEqual([])
        // in the desktop app the tab offers more tools than a request may carry, so the limit is really tested there
        if (platform === 'desktop') expect(most).toBeGreaterThan(CAP)
      } finally {
        off()
      }
    }, 120_000)
  }

  it('sends the per-turn pick on mimir cloud until its proxy says it takes tool search: no deferral, search tool or tool change', async () => {
    const off = await registerApp('desktop')
    try {
      for (const t of TURNS) {
        const { req, offered } = await turn('desktop', NEUTRAL, 'mimir cloud', t)
        const body = JSON.parse(req.body) as { tools?: Record<string, unknown>[]; messages: { role: string }[] }
        expect(offered, t.kind).toBeGreaterThan(CAP)
        expect(toolNames(req).length, t.kind).toBe(CAP)
        expect((body.tools ?? []).filter((x) => 'defer_loading' in x || x['type'] !== undefined).map((x) => x['name']), t.kind).toEqual([])
        expect(body.messages.filter((m) => m.role === 'system'), t.kind).toEqual([])
        expect(req.headers['anthropic-beta'], t.kind).toBeUndefined()
      }
    } finally {
      off()
    }
  }, 60_000)

  it('sends the whole catalog on mimir cloud in the desktop app once its proxy takes tool search, the same on every kind of turn', async () => {
    const off = await registerApp('desktop')
    try {
      const names = async (i: number) => toolNames((await turn('desktop', NEUTRAL, 'mimir cloud, tool search', TURNS[i]!)).req)
      const build = await names(0)
      expect(build.length).toBeGreaterThan(CAP)
      for (let i = 1; i < TURNS.length; i++) expect(await names(i), TURNS[i]!.kind).toEqual(build)
      expect(loadedNames((await turn('desktop', NEUTRAL, 'mimir cloud, tool search', TURNS[0]!)).req)).toEqual([...SEARCH_CORE.map((n) => n.replaceAll('.', '__')), SEARCH])
      expect(build).toEqual(expect.arrayContaining(['pilot__sheet', 'pilot__ask', 'design__new', 'design__plan', 'design__check', 'geom__extrude', 'geom__fillet', 'geom__mirror', 'geom__array', 'geom__sketch_edit', 'project__info', 'kb__search', 'memory__recall']))
      expect(build).toEqual(expect.arrayContaining(['app__slice', 'settings__get', 'settings__apply', 'printer__queue', 'printer__list', 'app__send_p1', 'printer__status', 'printer__pause', 'app__pause_p12', 'geom__rail', 'design__rename_part']))
      expect(build).not.toContain('pilot__load_tools')
    } finally {
      off()
    }
  }, 60_000)

  it('keeps every tool a capped build or print turn sent before the rail, and loads the rail only when asked for', async () => {
    const off = await registerApp('desktop')
    try {
      // what these turns sent at the cap before the rail tool was added (fixtures/capped-tools-main.json): the rail is
      // asked for by name, so the room left after the wanted toolsets never goes to it
      const before = JSON.parse(readFileSync(new URL('./fixtures/capped-tools-main.json', import.meta.url), 'utf8')) as { build: string[]; print: string[] }
      for (const mode of ['mimir cloud', 'openai key'] as Mode[])
        for (const [i, want] of [[0, before.build], [4, before.print]] as const) {
          const names = toolNames((await turn('desktop', NEUTRAL, mode, TURNS[i]!)).req)
          expect(names.length, `${TURNS[i]!.kind} turn, ${mode}`).toBe(CAP)
          expect(names, `${TURNS[i]!.kind} turn, ${mode}`).toContain('printer__queue')
          expect(want.filter((n) => !names.includes(n)), `${TURNS[i]!.kind} turn, ${mode}: tools it no longer sends`).toEqual([])
          expect(names, `${TURNS[i]!.kind} turn, ${mode}`).not.toContain('geom__rail')
        }
      const rail = toolNames((await turn('desktop', NEUTRAL, 'mimir cloud', { kind: 'rail', message: 'Add a railing all round the deck' })).req)
      expect(rail).toContain('geom__rail')
    } finally {
      off()
    }
  }, 60_000)

  it('sends the real-size lookup on a design turn, and holds it back on a print turn', async () => {
    const off = await registerApp('desktop')
    try {
      for (const mode of ['mimir cloud', 'openai key'] as Mode[]) {
        expect(toolNames((await turn('desktop', NEUTRAL, mode, TURNS[0]!)).req), `build turn, ${mode}`).toContain('design__lookup_sizes')
        expect(toolNames((await turn('desktop', NEUTRAL, mode, TURNS[4]!)).req), `print turn, ${mode}`).not.toContain('design__lookup_sizes')
      }
      // a local model plans without real sizes, so it is not offered the lookup
      expect(toolNames((await turn('desktop', NEUTRAL, 'local', TURNS[0]!)).req)).not.toContain('design__lookup_sizes')
    } finally {
      off()
    }
  }, 60_000)

  it('sends what main sent on a rail, a part rename, or a slice with a design change after a build, but for the lookup in and the trending command out', async () => {
    const off = await registerApp('desktop')
    try {
      // what main c0afa7726 sent on these turns (fixtures/capped-tools-mixed-main.json)
      const main = JSON.parse(readFileSync(new URL('./fixtures/capped-tools-mixed-main.json', import.meta.url), 'utf8')) as Record<string, string[]>
      const MIXED = [
        { kind: 'rail after a build', before: 'A 30 mm cube with a fillet', message: 'Add a railing all round the top', asked: 'geom__rail' },
        { kind: 'rename after a build', before: 'A 30 mm cube with a fillet', message: 'call that part the base', asked: 'design__rename_part' },
        { kind: 'slice and a design change', before: 'A 30 mm cube with a fillet', message: 'Make the base thicker and slice the plate' },
      ]
      for (const mode of ['mimir cloud', 'openai key'] as Mode[])
        for (const t of MIXED) {
          const key = `${t.kind}, ${mode}`
          const names = toolNames((await turn('desktop', NEUTRAL, mode, t)).req)
          const was = new Set(main[key])
          expect(names.length, key).toBe(CAP)
          expect(names.filter((n) => !was.has(n)), `${key}: added`).toEqual(['design__lookup_sizes'])
          expect([...was].filter((n) => !names.includes(n)), `${key}: removed`).toEqual(['app__library_trending'])
          if (t.asked) expect(names, key).toContain(t.asked)
        }
    } finally {
      off()
    }
  }, 60_000)

  it('sends the trending models command on a design turn only when it asks for the library or what is trending', async () => {
    const off = await registerApp('desktop')
    try {
      const build = toolNames((await turn('desktop', NEUTRAL, 'mimir cloud', TURNS[0]!)).req)
      expect(build).not.toContain('app__library_trending')
      // a print turn still sends it with the rest of core
      expect(toolNames((await turn('desktop', NEUTRAL, 'mimir cloud', TURNS[4]!)).req)).toContain('app__library_trending')
      for (const t of [
        { kind: 'trending', message: 'Show me the models trending this week' },
        { kind: 'trending after a build', before: 'A 30 mm cube with a fillet', message: 'What models are trending in the library?' },
      ]) {
        const names = toolNames((await turn('desktop', NEUTRAL, 'mimir cloud', t)).req)
        expect(names.length, t.kind).toBe(CAP)
        expect(names, t.kind).toContain('app__library_trending')
      }
    } finally {
      off()
    }
  }, 60_000)

  it('sends the part rename only on a part rename ask, and keeps every tool a capped build or print turn sent', async () => {
    const off = await registerApp('desktop')
    try {
      const before = JSON.parse(readFileSync(new URL('./fixtures/capped-tools-main.json', import.meta.url), 'utf8')) as { build: string[]; print: string[] }
      for (const mode of ['mimir cloud', 'openai key'] as Mode[])
        for (const [i, want] of [[0, before.build], [4, before.print]] as const) {
          const names = toolNames((await turn('desktop', NEUTRAL, mode, TURNS[i]!)).req)
          expect(want.filter((n) => !names.includes(n)), `${TURNS[i]!.kind} turn, ${mode}: tools it no longer sends`).toEqual([])
          expect(names, `${TURNS[i]!.kind} turn, ${mode}`).not.toContain('design__rename_part')
        }
      for (const message of ['rename the hull top top to Decks', 'call that part the funnel', 'name this part Lid'])
        expect(toolNames((await turn('desktop', NEUTRAL, 'mimir cloud', { kind: 'rename', message })).req), message).toContain('design__rename_part')
      for (const message of ['rename the project', 'rename this file to ship.3mf', 'save it as Titanic'])
        expect(toolNames((await turn('desktop', NEUTRAL, 'mimir cloud', { kind: 'rename', message })).req), message).not.toContain('design__rename_part')
    } finally {
      off()
    }
  }, 60_000)
})

/** The person's messages of a recorded chat: a part built, then eight follow-ups. */
const RECORDED = [
  'Make me a lighthouse',
  'Spread the windows out a little, they look crowded.',
  'Lean the railing posts back a few degrees.',
  'Make the gallery wider, nearly as wide as the tower under it.',
  'Add a row of round windows around the middle of the tower.',
  'Add rows of windows along the keeper house.',
  'Add a fence along both sides of the path.',
  'Take the fence off the back half.',
  'Paint it accordingly.',
]

/** What the model did on each of those turns, in the order it called the tools; `search` finds a deferred tool first. */
const CALLS: { name: string; search?: true }[][] = [
  [{ name: 'design.plan' }, { name: 'geom.loft' }, { name: 'geom.extrude' }],
  [{ name: 'design.edit_step' }],
  [{ name: 'design.edit_step' }],
  [{ name: 'geom.extrude' }],
  [{ name: 'geom.array' }],
  [{ name: 'geom.array' }],
  [{ name: 'geom.subtract', search: true }],
  [{ name: 'design.undo' }],
  [{ name: 'project.add_filament', search: true }, { name: 'paint.preview' }, { name: 'paint.apply' }],
]

const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

/** One reply in the Messages API's stream: a tool call (after a tool search for it), or a line of text. */
function reply(n: number, call?: { name: string; search?: true }): Uint8Array {
  const blocks: string[] = []
  const wire = call?.name.replaceAll('.', '__')
  if (call?.search) {
    blocks.push(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: `srvtoolu_${n}`, name: SEARCH } }))
    blocks.push(ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query: call.name }) } }))
    blocks.push(ev('content_block_stop', { type: 'content_block_stop', index: 0 }))
    const found = { type: 'tool_search_tool_result', tool_use_id: `srvtoolu_${n}`, content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: wire }] } }
    blocks.push(ev('content_block_start', { type: 'content_block_start', index: 1, content_block: found }) + ev('content_block_stop', { type: 'content_block_stop', index: 1 }))
  }
  const at = blocks.length ? 2 : 0
  if (call) {
    blocks.push(ev('content_block_start', { type: 'content_block_start', index: at, content_block: { type: 'tool_use', id: `toolu_${n}`, name: wire, input: {} } }))
    blocks.push(ev('content_block_delta', { type: 'content_block_delta', index: at, delta: { type: 'input_json_delta', partial_json: '{}' } }))
  } else {
    blocks.push(ev('content_block_start', { type: 'content_block_start', index: at, content_block: { type: 'text', text: '' } }))
    blocks.push(ev('content_block_delta', { type: 'content_block_delta', index: at, delta: { type: 'text_delta', text: 'Done, that is changed.' } }))
  }
  blocks.push(ev('content_block_stop', { type: 'content_block_stop', index: at }))
  return new TextEncoder().encode(
    ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }) +
      blocks.join('') +
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } }) +
      ev('message_stop', { type: 'message_stop' }),
  )
}

/**
 * A provider that plays the turn's calls in order, then answers in words, and keeps every request: a mimir cloud proxy
 * that takes tool search, so each reply opens with its event.
 */
function recordedProvider(): LlmTransport & { sent: LlmHttpRequest[]; turn: (i: number) => void } {
  const sent: LlmHttpRequest[] = []
  let queue: { name: string; search?: true }[] = []
  return {
    sent,
    turn: (i) => (queue = [...CALLS[i]!]),
    available: async () => true,
    async *stream(req) {
      sent.push(req)
      yield new TextEncoder().encode(PROXY_SAYS)
      yield reply(sent.length, queue.shift())
    },
  }
}

type Obj = Record<string, unknown>
const chars = (v: unknown): number => JSON.stringify(v).length

describe('a recorded chat on mimir cloud through the proxy', () => {
  const was = { pilot: get().pilot }
  beforeAll(() => registerMimirCloud({ quota: async () => { throw new Error('not read here') }, forget: async () => 0, register: async () => undefined }))
  afterAll(() => {
    resetTabMimir()
    registerMimirCloud(null)
    setHostSlices(true)
    set(was)
  })

  it('sends the same tools on every request: the core loaded, everything else deferred, the search tool, under the cap', async () => {
    const off = await registerApp('desktop')
    try {
      resetTabMimir()
      set({ pilot: MODES['mimir cloud'] as never })
      const llm = recordedProvider()
      const pilot = await tabMimir(hostFor('desktop', llm), withCloud(NEUTRAL), 'cloud')
      // a first chat hears the proxy say it takes tool search; the recorded chat is the next one
      for await (const _ of pilot.run('warm', 'hello')) void _
      llm.sent.splice(0)
      for (const [i, message] of RECORDED.entries()) {
        llm.turn(i)
        for await (const _ of pilot.run('s', message)) void _
      }
      // what the tab offers once its first run has loaded the connectors' tools
      const offered = pilot.tools().length
      expect(llm.sent.length).toBeGreaterThanOrEqual(RECORDED.length + CALLS.flat().length)
      const shaped = llm.sent.map((r, n) => {
        const s = shape(JSON.parse(r.body), undefined, r.headers['anthropic-beta'])
        if (!s.ok) throw new Error(`request ${n}: the proxy refused it: ${s.error}`)
        return s
      })
      // byte for byte the same tools on every request, as the app wrote them and as the proxy sends them on
      expect(new Set(llm.sent.map((r) => JSON.stringify((JSON.parse(r.body) as Obj)['tools']))).size).toBe(1)
      expect(new Set(shaped.map((s) => JSON.stringify(s.body['tools']))).size).toBe(1)
      const tools = shaped[0]!.body['tools'] as Obj[]
      expect(tools).toHaveLength(offered + 1)
      expect(tools.length).toBeLessThanOrEqual(MAX_TOOLS)
      const loaded = tools.filter((t) => t['defer_loading'] !== true)
      expect(loaded.map((t) => String(t['name']).replaceAll('__', '.'))).toEqual([...SEARCH_CORE, SEARCH])
      expect(loaded.at(-1)).toEqual({ type: 'tool_search_tool_bm25_20251119', name: SEARCH })
      expect(tools.filter((t) => t['defer_loading'] === true)).toHaveLength(offered - SEARCH_CORE.length)
      // nothing the chat was offered changed, so no tool change and no beta
      expect(shaped.flatMap((s) => (s.body['messages'] as Obj[]).filter((m) => m['role'] === 'system'))).toEqual([])
      expect(shaped.every((s) => !s.betas.includes(TOOL_CHANGES_BETA))).toBe(true)
      // each search goes back as it came, in the last request of the chat
      const last = JSON.stringify(shaped.at(-1)!.body['messages'])
      for (const n of ['geom__subtract', 'project__add_filament']) expect(last).toContain(`{"type":"tool_reference","tool_name":"${n}"}`)
      // the stable prefix: the tools that load, a token for every 4 characters, against 42,649 when 128 went in full
      const prefix = Math.round(chars(loaded) / 4)
      expect(prefix).toBeLessThan(42_649 / 2)
    } finally {
      off()
    }
  }, 120_000)
})
