// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab runs the model set up in Settings > mimir (a key on Auto, one pinned model, mimir cloud) over the
// design tools, and the scripted stub only when no model answers. The chat's link and the app link's mimir.tab say
// which, and the request a model gets carries the design prompt, the design tools and Auto's pick.
import type { Host, LlmHttpRequest, LlmTransport, MeshHandle, MeshPart, PilotEvent } from '@slicerx/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCall } from '../src/app-link/methods'
import { listSessions, readSession } from '../src/app-link/sessions'
import { currentEdition, NEUTRAL, setCurrentEdition } from '../src/edition'
import { registerMimirCloud } from '../src/pilot-connect/cloud'
import { get, set } from '../src/state/store'
import { mimirLink } from '../src/workspaces/mimir/connection'
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

  it('runs a key on Auto: Haiku for a short request, Sonnet for a picture, over the design tools and prompt', async () => {
    const llm = transport(['anthropic'])
    set({ pilot: { mode: 'on', provider: 'anthropic' } })
    const host = hostWith(llm)
    await tabMimir(host, NEUTRAL)
    expect(mimirLink.getState().link).toBe('model')
    const state = (await runCall('mimir.tab', {})) as { link: string; provider: string; model: string; auto: unknown; tools: string[] }
    expect(state).toMatchObject({ link: 'model', provider: 'anthropic', model: 'claude-haiku-5-5', auto: { huginn: 'claude-haiku-5-5', muninn: 'claude-sonnet-5-5' } })
    expect(state.tools).toEqual(expect.arrayContaining(['pilot.ask', 'pilot.sheet', 'lookup.show', 'design.new', 'geom.extrude', 'geom.revolve', 'geom.boolean', 'geom.fillet', 'kb.search', 'web.lookup']))
    expect(state.tools).not.toContain('text_to_part')
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
    expect(body(llm.sent[0]!).model).toBe('claude-sonnet-5-5')
    expect(pic.filter((e) => e.type === 'model_switch')).toMatchObject([{ label: 'Sonnet 5.5' }])

    llm.sent.length = 0
    await ask(host, 'A spur gear, 20 teeth, module 1')
    expect(body(llm.sent[0]!).model).toBe('claude-sonnet-5-5')
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

  it('reports none before the tab first opens', async () => {
    expect(await runCall('mimir.tab', {})).toEqual({ link: 'none', provider: null, model: null, auto: null, tools: [] })
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
