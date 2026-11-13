// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// On a capped mimir cloud chat the tools a request carries follow the chat, not only the message. The worst case is the
// desktop app with every connector and twelve printing printers (well over 128 tools offered, 128 sent). A "yes please" after
// mimir offers to print gets the printer tools, the list is the same request after request while the chat stays on its
// topic (so the proxy's prompt cache keeps hitting), and every request stays at 128 tools or under. Each request is read
// back from the HTTP body the provider adapter wrote.
import type { EditionConfig } from '@slicerx/edition-config'
import type { Host, LlmHttpRequest, LlmTransport, MeshHandle, PluginManifest, PrinterHost, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
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
import { runCall } from '../src/app-link/methods'
import { setTabChat } from '../src/app-link/sessions'
import { setHostSlices } from '../src/state/model-mode'
import { get, set } from '../src/state/store'
import { resetTabMimir, tabMimir } from '../src/workspaces/mimir/session'

const CAP = 128
const CONNECTORS = JSON.parse(readFileSync(new URL('../../connect/manifests.json', import.meta.url), 'utf8')) as PluginManifest[]
const FLEET = Array.from({ length: 12 }, (_, i) => ({ id: `p${i + 1}`, name: `Printer ${i + 1}`, vendor: 'Prusa', model: 'MK4', plugin: 'prusalink', nozzleCount: 1 }) as PrinterInfo)
const printers = {
  list: async () => FLEET,
  plugins: async () => CONNECTORS,
  fleets: async () => [],
  status: async () => ({ state: 'printing', cameraAvailable: true }) as unknown as PrinterStatus,
  subscribe: () => () => undefined,
} as unknown as PrinterHost

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })

/** One Messages API reply as the proxy streams it: a line of text, or one tool call. */
function reply(step: { text?: string; call?: { name: string; input?: unknown } }): Uint8Array {
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const block = step.call
    ? ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${step.call.name}`, name: step.call.name, input: {} } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.call.input ?? {}) } })
    : ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text ?? 'Done.' } })
  return new TextEncoder().encode(
    ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }) +
      block +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: step.call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } }) +
      ev('message_stop', { type: 'message_stop' }),
  )
}

/** A transport that keeps each request and plays the replies in order. */
function transport(steps: { text?: string; call?: { name: string; input?: unknown } }[]): LlmTransport & { sent: LlmHttpRequest[] } {
  const sent: LlmHttpRequest[] = []
  let i = 0
  return {
    sent,
    available: async () => true,
    async *stream(req) {
      sent.push(req)
      yield reply(steps[i++] ?? { text: 'Done.' })
    },
  }
}

type Platform = 'desktop' | 'web'
const hostFor = (kind: Platform, llm: LlmTransport): Host => ({ kind, capabilities: { secureStorage: true }, slicer: { loadParts: async (n: string) => handle(n) }, printers, build: { version: '0.0.0-test' }, llm }) as unknown as Host
const withCloud = (e: EditionConfig): EditionConfig => ({ ...e, ai: { ...e.ai, keySource: 'cloud' }, backend: { ...e.backend, supabase: { url: 'https://abcdefghijklmnop.supabase.co', anonKey: 'public-anon-key-from-the-supabase-dashboard' } } })

/** A request's tools as the body carries them (names, descriptions and schemas), and their names. */
const toolsJson = (req: LlmHttpRequest): string => JSON.stringify((JSON.parse(req.body) as { tools?: unknown[] }).tools ?? [])
const toolNames = (req: LlmHttpRequest): string[] => ((JSON.parse(req.body) as { tools?: { name?: string }[] }).tools ?? []).map((t) => String(t.name ?? ''))

const WORKSPACES = [
  { id: 'prepare', label: 'Slice' },
  { id: 'library', label: 'My models' },
  { id: 'printers', label: 'Printers' },
]

async function registerApp(platform: Platform): Promise<() => void> {
  setHostSlices(platform === 'desktop')
  const host = hostFor(platform, transport([]))
  const off = registerCommands([...builtinCommands(host, WORKSPACES), ...setupCommands(), ...[storeFeature, fleetFeature, pilotFeature, cloudFeature].flatMap((f) => f.commands?.(host) ?? [])])
  await new Promise((r) => setTimeout(r, 20))
  return off
}

/** A fresh mimir cloud chat in the desktop app, with the replies it plays. */
async function chat(steps: Parameters<typeof transport>[0]) {
  resetTabMimir()
  set({ pilot: { mode: 'on', provider: 'mimir-cloud' } as never })
  const llm = transport(steps)
  const pilot = await tabMimir(hostFor('desktop', llm), withCloud(NEUTRAL), 'cloud')
  const say = async (message: string): Promise<LlmHttpRequest[]> => {
    const at = llm.sent.length
    for await (const _ of pilot.run('s', message)) void _
    return llm.sent.slice(at)
  }
  return { llm, pilot, say }
}

const OFFER = 'Your hook is ready: 40 mm tall, with a 6 mm screw hole. Want me to slice it and send it to Printer 3?'
const PRINTING = ['printer__queue', 'printer__list', 'printer__status', 'app__send_p3']
/** Each printer's send and pause commands: the ones a print offer needs whichever printer it names. */
const EVERY_PRINTER = FLEET.flatMap((p) => [`app__send_${p.id}`, `app__pause_${p.id}`])
/** A build turn as mimir runs one: the sheet, the plan, the design and the geometry tools. */
const BUILD_TURN = [
  { call: { name: 'pilot__sheet', input: { title: 'Wall hook', dims: [] } } },
  { call: { name: 'design__plan', input: {} } },
  { call: { name: 'design__new', input: { name: 'Hook' } } },
  { call: { name: 'geom__extrude', input: {} } },
  { call: { name: 'geom__fillet', input: {} } },
]

describe('a capped mimir cloud chat keeps its tools across messages', () => {
  const was = { pilot: get().pilot }
  let off: () => void = () => undefined
  beforeAll(async () => {
    registerMimirCloud({ quota: async () => { throw new Error('not read here') }, forget: async () => 0, register: async () => undefined })
    off = await registerApp('desktop')
  })
  afterAll(() => {
    off()
    resetTabMimir()
    registerMimirCloud(null)
    setHostSlices(true)
    set(was)
  })

  for (const yes of ['yes please', 'sure, go ahead'])
    for (const built of ['none', 'new', 'build'] as const)
      it(`"${yes}" after mimir offers to print gets the printer tools${built === 'new' ? ', after a turn that started a design' : built === 'build' ? ', after a full build turn' : ''}`, async () => {
        const make = built === 'new' ? [{ call: { name: 'design__new', input: { name: 'Hook' } } }] : built === 'build' ? BUILD_TURN : []
        const { pilot, say } = await chat([...make, { text: OFFER }, { text: 'Sending it now.' }])
        const first = await say('Make a wall hook for a 6 mm screw')
        expect(pilot.tools().length).toBeGreaterThan(CAP)
        for (const r of first) expect(toolNames(r).length).toBeLessThanOrEqual(CAP)
        const second = await say(yes)
        const names = toolNames(second[0]!)
        expect(names.length).toBeLessThanOrEqual(CAP)
        expect(names).toEqual(expect.arrayContaining([...PRINTING, ...EVERY_PRINTER, 'app__slice']))
        // the design tools the last turn called from stay
        if (built !== 'none') expect(names).toEqual(expect.arrayContaining(['design__new', 'design__plan', 'geom__extrude', 'geom__fillet']))
      })

  for (const ask of ['Print it on Printer 2 in green PLA', 'Print this on my Printer 6', 'Send it anyway'])
    it(`"${ask}" as the first message gets the slicing tools beside the printer and design tools`, async () => {
      const { say } = await chat([{ text: 'Slicing it now.' }])
      const names = toolNames((await say(ask))[0]!)
      expect(names.length).toBeLessThanOrEqual(CAP)
      // what the print run calls first: where it goes, the slice and the queue, and the printer it names
      expect(names).toEqual(expect.arrayContaining(['run__target', 'slice', 'app__slice', 'printer__queue', ...EVERY_PRINTER]))
      // the tab's design tools stay
      expect(names).toEqual(expect.arrayContaining(['design__new', 'geom__extrude', 'geom__fillet']))
    })

  it('sends the rail tool on a turn that asks for a rail, and leaves it to the room left otherwise', async () => {
    const { say } = await chat([{ text: 'Adding it.' }])
    const names = toolNames((await say('Add a railing all round the deck'))[0]!)
    expect(names.length).toBeLessThanOrEqual(CAP)
    expect(names).toEqual(expect.arrayContaining(['geom__rail', 'design__new', 'geom__extrude', 'geom__fillet']))
  })

  it('sends the same tools on every step of a turn and on the next turn on the same topic', async () => {
    const { say } = await chat([{ call: { name: 'printer__list' } }, { call: { name: 'printer__status', input: { printerId: 'p3' } } }, { text: 'Printer 3 is printing.' }, { call: { name: 'printer__list' } }, { text: 'Printer 3 is still printing.' }])
    const one = await say("How's the print on printer 3 going?")
    expect(one.length).toBe(3)
    const two = await say('And is printer 3 almost done now?')
    expect(two.length).toBe(2)
    const all = [...one, ...two]
    for (const r of all) expect(toolNames(r).length).toBeLessThanOrEqual(CAP)
    const bytes = all.map(toolsJson)
    expect(new Set(bytes).size, 'distinct tool lists across five requests of two turns').toBe(1)
  })

  it('keeps the toolsets of the last turn when a new message needs others', async () => {
    const { say } = await chat([{ call: { name: 'printer__list' } }, { text: 'Printer 3 is printing.' }, { text: 'PLA works for that.' }])
    const one = await say("How's the print on printer 3 going?")
    const before = toolNames(one[0]!)
    expect(before).toEqual(expect.arrayContaining(PRINTING))
    // a question that needs the knowledge base and mesh edits, and names no printer
    const two = await say('Why does my mesh look broken, should I repair it?')
    const after = toolNames(two[0]!)
    expect(after.length).toBeLessThanOrEqual(CAP)
    // the printer tools were called in the last turn, so all of them stay, and the mesh toolset the message asks for (its cut tool here) comes in
    expect(before).toEqual(expect.arrayContaining(EVERY_PRINTER))
    expect(after).toEqual(expect.arrayContaining([...PRINTING, ...EVERY_PRINTER, 'cut']))
  })

  it('reads what the open chat sent over the app link: the toolsets in and left out, and pilot.load_tools', async () => {
    const { say } = await chat([{ text: OFFER }, { text: 'Sending it now.' }])
    await say('Make a wall hook for a 6 mm screw')
    await say('yes please')
    setTabChat('s')
    try {
      const tab = (await runCall('mimir.tab', {})) as { tools: string[]; capped: { cap: number; offered: number; sent: number; toolsets: string[]; leftOut: string[]; partial: { toolset: string; sent: number; of: number }[]; loader: string | null } | null }
      expect(tab.tools.length).toBeGreaterThan(CAP)
      expect(tab.capped).toMatchObject({ cap: CAP, offered: tab.tools.length, sent: CAP, loader: 'pilot.load_tools' })
      expect(tab.capped!.toolsets).toEqual(expect.arrayContaining(['core', 'cad', 'settings']))
      // the printers fill the rest of the room: every printer's commands, not yet every connector's tools
      expect(tab.capped!.partial).toEqual([{ toolset: 'printers', sent: expect.any(Number), of: 64 }])
      expect(tab.capped!.partial[0]!.sent).toBeGreaterThanOrEqual(EVERY_PRINTER.length)
    } finally {
      setTabChat(null)
    }
  })

  it('reads no loader over the app link on a local model over the limit, which has no pilot.load_tools', async () => {
    // a local turn always carries the app's commands, so enough of them push its pick over the limit
    const extra = registerCommands(Array.from({ length: 90 }, (_, i) => ({ id: `probe-command-${i}`, title: `Probe command ${i}`, section: 'view' as const, tool: { permission: 'read' as const }, run: () => undefined })))
    try {
      resetTabMimir()
      set({ pilot: { mode: 'on', provider: 'local', model: 'qwen3:8b-16k', baseUrl: 'http://127.0.0.1:11434/v1' } as never })
      const llm = transport([{ text: 'Done.' }])
      const pilot = await tabMimir(hostFor('desktop', llm), NEUTRAL)
      for await (const _ of pilot.run('s', 'Print it on Bay 2')) void _
      expect(toolNames(llm.sent[0]!).length).toBe(CAP)
      expect(toolNames(llm.sent[0]!)).not.toContain('pilot.load_tools')
      setTabChat('s')
      try {
        const tab = (await runCall('mimir.tab', {})) as { local: boolean; capped: { cap: number; loader: string | null } | null }
        expect(tab.local).toBe(true)
        expect(tab.capped).not.toBeNull()
        expect(tab.capped!.cap).toBe(CAP)
        expect(tab.capped!.loader).toBeNull()
      } finally {
        setTabChat(null)
      }
    } finally {
      extra()
    }
  })
})
