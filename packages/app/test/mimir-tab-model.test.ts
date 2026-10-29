// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab runs the model set up in Settings > mimir (a key on Auto, one pinned model, mimir cloud) over the
// design tools and the slicing, printer and settings tools, and the scripted stub only when no model answers. The chat's link and the app link's mimir.tab say
// which, and the request a model gets carries the design prompt, the design tools and Auto's pick.
import type { Host, LlmHttpRequest, LlmTransport, MeshHandle, MeshPart, PilotEvent } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool } from '@slicerx/pilot'
import { DEFAULT_POLICY } from '@slicerx/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runCall } from '../src/app-link/methods'
import { listSessions, readSession } from '../src/app-link/sessions'
import { currentEdition, NEUTRAL, setCurrentEdition } from '../src/edition'
import { guardedPrinters } from '../src/plate/guard'
import { createSendLedger } from '../src/plate/send-ledger'
import { registerMimirCloud } from '../src/pilot-connect/cloud'
import { setHostSlices } from '../src/state/model-mode'
import { get, set } from '../src/state/store'
import { mimirLink } from '../src/workspaces/mimir/connection'
import { appPrintRun } from '../src/workspaces/mimir/print-run'
import { mimirLogs, resetTabMimir, tabMimir, tabModel } from '../src/workspaces/mimir/session'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }

/** An Anthropic Messages stream that says one line, so a run ends cleanly. */
function said(text: string): Uint8Array {
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  return new TextEncoder().encode(
    ev('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'x', usage: { input_tokens: 10, output_tokens: 0 } } }) +
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }) +
      ev('message_stop', { type: 'message_stop' }),
  )
}

/** A host's keychain transport: answers for the providers it has a key for, and records every request. */
function transport(keys: readonly string[]): LlmTransport & { sent: LlmHttpRequest[] } {
  const sent: LlmHttpRequest[] = []
  return {
    sent,
    available: async (p) => keys.includes(p),
    async *stream(req) {
      sent.push(req)
      yield said('Done.')
    },
  }
}

const hostWith = (llm?: LlmTransport): Host => ({ kind: 'desktop', capabilities: { secureStorage: true }, slicer: loader, build: { version: '0.0.0-test' }, ...(llm ? { llm } : {}) }) as unknown as Host

async function ask(host: Host, message: string, files: { name: string; type: string }[] = []): Promise<PilotEvent[]> {
  const pilot = await tabMimir(host, currentEdition())
  const out: PilotEvent[] = []
  const attachments = files.map((f, i) => ({ id: `f${i}`, name: f.name, type: f.type, bytes: 4, url: `data:${f.type};base64,AAAA` }))
  for await (const e of pilot.run(`s_${message.length}`, message, attachments.length ? { attachments } : {})) out.push(e)
  return out
}

const body = (r: LlmHttpRequest) => JSON.parse(r.body) as { model: string; system?: unknown; tools?: { name: string }[] }

describe('the mimir tab on a model', () => {
  const was = { pilot: get().pilot }
  const edition = currentEdition()
  beforeEach(() => resetTabMimir())
  afterEach(() => {
    resetTabMimir()
    registerMimirCloud(null)
    setCurrentEdition(edition)
    set(was)
  })

  it('plays the scripts when no model is set up, and says so', async () => {
    set({ pilot: { mode: 'unset' } })
    const pilot = await tabMimir(hostWith(), NEUTRAL)
    expect(mimirLink.getState().link).toBe('scripted')
    expect(tabModel()).toEqual({ link: 'scripted', provider: 'scripted', model: 'scripted' })
    const ev: PilotEvent[] = []
    for await (const e of pilot.run('s', 'hello')) ev.push(e)
    expect(ev.find((e) => e.type === 'start')).toMatchObject({ provider: 'scripted' })
    expect(await runCall('mimir.tab', {})).toMatchObject({ link: 'scripted', provider: 'scripted', model: 'scripted', auto: null })
  })

  it('falls back to the scripts when the chosen provider has no key, and when mimir is off', async () => {
    set({ pilot: { mode: 'on', provider: 'anthropic' } })
    await tabMimir(hostWith(transport([])), NEUTRAL)
    expect(mimirLink.getState().link).toBe('scripted')
    resetTabMimir()
    set({ pilot: { mode: 'off' } })
    await tabMimir(hostWith(transport(['anthropic'])), NEUTRAL)
    expect(mimirLink.getState().link).toBe('scripted')
  })

  it('runs a key on Auto: Haiku for a short request or a picture, Sonnet for a many-step part, over the design tools and prompt', async () => {
    const llm = transport(['anthropic'])
    set({ pilot: { mode: 'on', provider: 'anthropic' } })
    const host = hostWith(llm)
    await tabMimir(host, NEUTRAL)
    expect(mimirLink.getState().link).toBe('model')
    const state = (await runCall('mimir.tab', {})) as { link: string; provider: string; model: string; auto: unknown; tools: string[] }
    expect(state).toMatchObject({ link: 'model', provider: 'anthropic', model: 'claude-haiku-5-5', auto: { huginn: 'claude-haiku-5-5', muninn: 'claude-sonnet-5-5' } })
    expect(state.tools).toEqual(expect.arrayContaining(['pilot.ask', 'pilot.sheet', 'lookup.show', 'design.new', 'geom.extrude', 'geom.revolve', 'geom.boolean', 'geom.fillet', 'kb.search', 'web.lookup']))
    // what the docked chat had: printers (approvals stay with the person), settings, the project and the report
    expect(state.tools).toEqual(expect.arrayContaining(['printer.list', 'printer.queue', 'settings.plan', 'settings.apply', 'project.info', 'pilot.report', 'kb.intent']))
    expect(state.tools).not.toContain('text_to_part')
    expect(state.tools).not.toContain('make_model')
    expect(state).toMatchObject({ local: false })
    expect(JSON.stringify(state)).not.toMatch(/key|token/i)

    const ev = await ask(host, 'A 30 mm cube with a fillet')
    expect(ev.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' })
    const first = body(llm.sent[0]!)
    expect(first.model).toBe('claude-haiku-5-5')
    expect(JSON.stringify(first.system)).toContain('one feature at a time')
    const sentTools = (first.tools ?? []).map((t) => t.name)
    expect(sentTools.some((n) => n.startsWith('geom'))).toBe(true)
    expect(sentTools.some((n) => /text_to_part/.test(n))).toBe(false)

    llm.sent.length = 0
    const pic = await ask(host, 'Build this', [{ name: 'sketch.png', type: 'image/png' }])
    expect(body(llm.sent[0]!).model).toBe('claude-haiku-5-5')
    expect(pic.filter((e) => e.type === 'model_switch')).toEqual([])

    llm.sent.length = 0
    await ask(host, 'A spur gear, 20 teeth, module 1')
    expect(body(llm.sent[0]!).model).toBe('claude-sonnet-5-5')
  })

  it("says where the model runs (this computer, your network or the model's server), and lists the tools it is offered", async () => {
    set({ pilot: { mode: 'on', provider: 'local', model: 'qwen3:8b-16k', baseUrl: 'http://127.0.0.1:11434/v1' } })
    await tabMimir(hostWith(transport(['openai-compatible'])), NEUTRAL)
    const state = (await runCall('mimir.tab', {})) as { link: string; local: boolean; tools: string[] }
    expect(state).toMatchObject({ link: 'model', provider: 'openai-compatible', local: true, where: 'computer' })
    expect(state.tools).toEqual(expect.arrayContaining(['design.new', 'pilot.sheet', 'printer.queue']))
    expect(state.tools).not.toContain('make_model')
  })

  it('names where the model runs by its address: a local model on the network is not on this computer', async () => {
    set({ pilot: { mode: 'on', provider: 'local', model: 'qwen3:8b-16k', baseUrl: 'http://192.168.1.20:11434/v1' } })
    await tabMimir(hostWith(transport(['openai-compatible'])), NEUTRAL)
    // still a local model for the tool list, but its server is on the network
    expect(await runCall('mimir.tab', {})).toMatchObject({ link: 'model', local: true, where: 'network' })
    resetTabMimir()
    set({ pilot: { mode: 'on', provider: 'anthropic' } })
    await tabMimir(hostWith(transport(['anthropic'])), NEUTRAL)
    expect(await runCall('mimir.tab', {})).toMatchObject({ link: 'model', local: false, where: 'remote' })
    resetTabMimir()
    set({ pilot: { mode: 'unset' } })
    await tabMimir(hostWith(), NEUTRAL)
    expect(await runCall('mimir.tab', {})).toMatchObject({ link: 'scripted', where: null })
  })

  it('in the browser build, keeps the design tools and leaves out slicing and printers', async () => {
    setHostSlices(false)
    try {
      set({ pilot: { mode: 'on', provider: 'anthropic' } })
      await tabMimir(hostWith(transport(['anthropic'])), NEUTRAL)
      const state = (await runCall('mimir.tab', {})) as { tools: string[] }
      expect(state.tools).toEqual(expect.arrayContaining(['design.new', 'pilot.sheet', 'kb.search', 'project.info']))
      for (const n of ['printer.queue', 'printer.list', 'settings.plan', 'text_to_part']) expect(state.tools).not.toContain(n)
    } finally {
      setHostSlices(true)
    }
  })

  it('runs one pinned model for every message, a picture included', async () => {
    const llm = transport(['anthropic'])
    set({ pilot: { mode: 'on', provider: 'anthropic', model: 'claude-sonnet-5-5' } })
    const host = hostWith(llm)
    await tabMimir(host, NEUTRAL)
    expect(await runCall('mimir.tab', {})).toMatchObject({ link: 'model', model: 'claude-sonnet-5-5', auto: null })
    await ask(host, 'Build this', [{ name: 'sketch.png', type: 'image/png' }])
    await ask(host, 'A cube')
    expect(new Set(llm.sent.map((r) => body(r).model))).toEqual(new Set(['claude-sonnet-5-5']))
  })

  it('runs mimir cloud on its one model when the edition carries it and nothing else is chosen', async () => {
    const CLOUD = { ...NEUTRAL, ai: { ...NEUTRAL.ai, keySource: 'cloud' as const }, backend: { ...NEUTRAL.backend, supabase: { url: 'https://abcdefghijklmnop.supabase.co', anonKey: 'public-anon-key-from-the-supabase-dashboard' } } }
    setCurrentEdition(CLOUD)
    registerMimirCloud({ quota: async () => { throw new Error('not read here') }, forget: async () => 0, register: async () => undefined })
    set({ pilot: null })
    const llm = transport(['mimir-cloud'])
    const host = hostWith(llm)
    await tabMimir(host, CLOUD, 'cloud')
    expect(await runCall('mimir.tab', {})).toMatchObject({ link: 'model', provider: 'mimir-cloud', model: 'claude-haiku-5-5', auto: null })
    await ask(host, 'Build this', [{ name: 'drawing.pdf', type: 'application/pdf' }])
    expect(llm.sent[0]!.provider).toBe('mimir-cloud')
    expect(body(llm.sent[0]!).model).toBe('claude-haiku-5-5')
  })

  it('sets the runtime up again when the edition turns memory off or on, with the memory tools to match', async () => {
    set({ pilot: { mode: 'on', provider: 'anthropic' } })
    const host = hostWith(transport(['anthropic']))
    const on = await tabMimir(host, NEUTRAL)
    expect(on.tools().map((t) => t.name)).toContain('memory.remember')
    expect(await tabMimir(host, NEUTRAL)).toBe(on)
    // the same edition id with memory switched off
    const OFF = { ...NEUTRAL, ai: { ...NEUTRAL.ai, brain: { ...NEUTRAL.ai.brain, memory: { ...NEUTRAL.ai.brain.memory, local: false } } } }
    const off = await tabMimir(host, OFF)
    expect(off).not.toBe(on)
    expect(off.tools().map((t) => t.name)).not.toContain('memory.remember')
    expect(off.tools().map((t) => t.name)).not.toContain('memory.recall')
    const again = await tabMimir(host, NEUTRAL)
    expect(again).not.toBe(off)
    expect(again.tools().map((t) => t.name)).toContain('memory.remember')
  })

  it('sets the runtime up again when Settings change the model, and keeps it otherwise', async () => {
    const llm = transport(['anthropic'])
    const host = hostWith(llm)
    set({ pilot: { mode: 'unset' } })
    const stub = await tabMimir(hostWith(), NEUTRAL)
    expect(await tabMimir(hostWith(), NEUTRAL)).toBe(stub)
    set({ pilot: { mode: 'on', provider: 'anthropic' } })
    const model = await tabMimir(host, NEUTRAL)
    expect(model).not.toBe(stub)
    expect(mimirLink.getState().link).toBe('model')
  })

  it('keeps the runtime when the bridge comes back, so its open cards stay answerable', async () => {
    set({ pilot: { mode: 'unset' } })
    const printers = () => ({ list: async () => [], plugins: async () => [], subscribe: () => () => undefined }) as unknown as NonNullable<Host['printers']>
    const host = hostWith()
    host.printers = printers()
    const first = await tabMimir(host, NEUTRAL)
    // the bridge came back: its new connection's printers replace the dropped one's, in a new epoch
    host.printers = printers()
    set((s) => ({ linkEpoch: s.linkEpoch + 1 }))
    expect(await tabMimir(host, NEUTRAL)).toBe(first)
    // the watch on a started print reads the host's printers as they are now
    expect(appPrintRun(host).printers?.()).toBe(host.printers)
  })

  it('a send card open across a reconnect still prints, through the new connection', async () => {
    const info = { id: 'bay-2', name: 'Bay 2', vendor: 'Bambu Lab', model: 'P1S', plugin: 'bambu-lan', nozzleCount: 1 }
    const connection = () => {
      const calls: string[] = []
      const printers = {
        list: async () => [info],
        plugins: async () => [],
        status: async () => ({ printerId: 'bay-2', state: 'idle', nozzles: [], slots: [], cameraAvailable: false, updatedAt: '' }),
        subscribe: () => () => undefined,
        upload: async (id: string, f: { name: string }) => {
          calls.push(`upload ${f.name}`)
          return { printerId: id, path: `/${f.name}`, name: f.name }
        },
        start: async (f: { name: string }) => void calls.push(`start ${f.name}`),
      } as unknown as NonNullable<Host['printers']>
      return { printers, calls }
    }
    const SHA = 'ab'.repeat(32)
    const send = defineTool<Record<string, never>>({
      name: 'printer.queue',
      version: '1',
      description: 'Sends the plate and starts it',
      source: 'command',
      permission: 'queue',
      input: z.object({}),
      async run(_i, ctx) {
        const file = { name: 'clip.gcode.3mf', kind: 'gcode.3mf' as const, data: new ArrayBuffer(0), sha256: SHA }
        const remote = await ctx.host.printers.upload('bay-2', file, ctx.token!)
        await ctx.host.printers.start(remote, {}, ctx.token!)
        return { summary: 'Printing' }
      },
    })
    const before = connection()
    const host = { printers: before.printers } as Pick<Host, 'printers'>
    const ledger = createSendLedger()
    const pilot = createPilot({
      host: { printers: guardedPrinters(host, { ledger })!, approvals: createApprovalBroker(), llm: {} as LlmTransport },
      config: DEFAULT_CONFIG,
      policy: DEFAULT_POLICY,
      client: createScriptedClient([{ calls: [{ name: 'printer.queue', args: {} }] }, { text: 'Printing.' }], { chunk: false }),
      builtins: false,
      tools: [send] as never[],
      printRun: appPrintRun(host),
    })
    const after = connection()
    const events: PilotEvent[] = []
    for await (const ev of pilot.run('s', 'print it')) {
      events.push(ev)
      if (ev.type !== 'approval_request') continue
      // the bridge dropped and came back while the card waited; the person ticks the bed and presses Print
      host.printers = after.printers
      set((s) => ({ linkEpoch: s.linkEpoch + 1 }))
      ledger.mark(ev.request.id, 'bay-2', SHA, new Date(Date.now() + 60_000).toISOString())
      await pilot.resolveApproval(ev.request.id, { kind: 'approve' })
    }
    expect(events.filter((e) => e.type === 'tool_result')).toEqual([expect.objectContaining({ ok: true })])
    expect(after.calls).toEqual(['upload clip.gcode.3mf', 'start clip.gcode.3mf'])
    expect(before.calls).toEqual([])
    expect(get().approval).toBeNull()
  })

  it('reports none before the tab first opens', async () => {
    expect(await runCall('mimir.tab', {})).toEqual({ link: 'none', provider: null, model: null, auto: null, local: false, where: null, tools: [], turns: null })
  })

  it('logs the model conversation for the read-back', async () => {
    const llm = transport(['anthropic'])
    set({ pilot: { mode: 'on', provider: 'anthropic' } })
    const { setSessionSource } = await import('../src/app-link/sessions')
    setSessionSource({ store: mimirLogs })
    try {
      await ask(hostWith(llm), 'Read back this one')
      const list = (await listSessions()) as { sessions: { id: string }[] }
      const id = list.sessions.find((s) => s.id === 's_18')?.id
      expect(id).toBe('s_18')
      const read = (await readSession({ id: id! })) as { turns: { steps: { kind: string; text?: string }[] }[] }
      expect(read.turns.at(-1)!.steps).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'said', text: 'Done.' })]))
    } finally {
      setSessionSource(null)
    }
  })
})
