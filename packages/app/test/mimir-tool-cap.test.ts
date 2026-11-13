// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// No mimir tab request carries more than 128 tools. mimir cloud's proxy refuses a longer list
// (supabase/functions/mimir/shape.ts), and so do OpenAI-style APIs and local servers. The tab is made the way the app
// makes it, with the commands the app registers at startup, its features' commands, a command per connected printer
// and every connector's tools, and each request is read back from the HTTP body the provider adapter wrote. Every kind
// of turn is checked in the desktop app (which slices and prints) and the browser build (which only models), on mimir
// cloud, a key and a local model, in the neutral edition and in one with the printer and web tools off.
import type { EditionConfig } from '@slicerx/edition-config'
import type { Host, LlmHttpRequest, LlmTransport, MeshHandle, PluginManifest, PrinterHost, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { MIMIR_CLOUD_MAX_TOOLS } from '@slicerx/pilot'
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

/** How mimir runs: mimir cloud, a key on an OpenAI-style API, and a local model. */
const MODES = {
  'mimir cloud': { mode: 'on', provider: 'mimir-cloud' },
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

/** The first request of a turn in a fresh chat, after `before` when given, and how many tools the tab offers. */
async function turn(platform: Platform, edition: EditionConfig, mode: Mode, t: (typeof TURNS)[number]): Promise<{ req: LlmHttpRequest; offered: number }> {
  resetTabMimir()
  set({ pilot: MODES[mode] as never })
  const llm = transport()
  const cloud = mode === 'mimir cloud'
  const pilot = await tabMimir(hostFor(platform, llm), cloud ? withCloud(edition) : edition, cloud ? 'cloud' : null)
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

describe('no mimir tab request carries more than 128 tools', () => {
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
  })

  for (const platform of ['desktop', 'web'] as const) {
    it(`sends at most ${CAP} tools on every turn in the ${platform === 'desktop' ? 'desktop app' : 'browser build'}`, async () => {
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
              most = Math.max(most, offered)
              if (names.length > CAP) over.push(`${t.kind} turn, ${ename}, ${mode}: ${names.length} tools`)
              if (mode === 'mimir cloud') badNames.push(...names.filter((n) => !TOOL_NAME.test(n)))
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

  it('keeps the tools each turn needs on mimir cloud in the desktop app', async () => {
    const off = await registerApp('desktop')
    try {
      const names = async (i: number) => toolNames((await turn('desktop', NEUTRAL, 'mimir cloud', TURNS[i]!)).req)
      const build = await names(0)
      expect(build.length).toBe(CAP)
      expect(build).toEqual(expect.arrayContaining(['pilot__sheet', 'pilot__ask', 'design__new', 'design__plan', 'design__check', 'geom__extrude', 'geom__fillet', 'geom__mirror', 'geom__array', 'geom__sketch_edit', 'project__info', 'kb__search', 'memory__recall']))
      expect(await names(3)).toEqual(expect.arrayContaining(['app__slice', 'settings__get', 'settings__apply', 'printer__queue', 'printer__list', 'app__send_p1']))
      expect(await names(4)).toEqual(expect.arrayContaining(['printer__status', 'printer__pause', 'printer__queue', 'app__pause_p12']))
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
