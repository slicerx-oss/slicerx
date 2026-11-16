// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A fresh SlicerX desktop install with nothing set up runs the mimir tab on mimir cloud, and every request asks the
// proxy for the stronger model (ai.brain.cloud.everyTurn step): a first build, the sheet it asks, the next run, a
// follow-up and a question alike. An edition that asks only on hard turns (layermate) and the browser build (the proxy's
// slicerx-web edition) keep Auto's pick, and a person who sets up their own key sends no tier at all.
import type { EditionConfig } from '@slicerx/edition-config'
import type { Host, LlmHttpRequest, LlmTransport, PilotEvent } from '@slicerx/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NEUTRAL, setCurrentEdition } from '../src/edition'
import { registerMimirCloud } from '../src/pilot-connect/cloud'
import { get, set } from '../src/state/store'
import { resetTabMimir, tabMimir } from '../src/workspaces/mimir/session'

// the edition file reads its backend from the environment when it loads, as a release build does
vi.stubEnv('SLICERX_SUPABASE_URL', 'https://abcdefghijklmnop.supabase.co')
vi.stubEnv('SLICERX_SUPABASE_ANON_KEY', 'sb_publishable_placeholder_key_0123456789')
const SLICERX = (await import('../../../editions/slicerx/edition.config.ts')).default as EditionConfig
vi.unstubAllEnvs()

const HAIKU = 'claude-haiku-5-5'

const sse = (events: unknown[]): Uint8Array => new TextEncoder().encode(events.map((d) => `event: ${(d as { type: string }).type}\ndata: ${JSON.stringify(d)}\n\n`).join(''))
const start = { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'x', usage: { input_tokens: 10, output_tokens: 0 } } }

/** A reply that says one line and ends the run. */
const said = (text: string) =>
  sse([
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ])

/** A reply that calls one tool. */
const calls = (name: string, args: unknown) =>
  sse([
    start,
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call_${name}`, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ])

// a size sheet that waits for the person: the rocket must fit their launch rod
const SHEET = { title: 'Toy rocket', fits: true, dims: [{ key: 'rod', label: 'Launch rod', value: 5, unit: 'mm', source: 'asked' }] }

/** The host's transport for mimir cloud: the next scripted reply for each request (plain text once they run out), every request kept. */
function transport(provider: string, replies: Uint8Array[] = []): LlmTransport & { sent: LlmHttpRequest[] } {
  const sent: LlmHttpRequest[] = []
  return {
    sent,
    available: async (p) => p === provider,
    async *stream(req) {
      sent.push(req)
      yield replies.shift() ?? said('Done.')
    },
  }
}

const loader = { loadParts: async (name: string) => ({ id: name, hash: name, name, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }) }
const hostWith = (llm: LlmTransport, kind: Host['kind'] = 'desktop'): Host => ({ kind, capabilities: { secureStorage: true }, slicer: loader, build: { version: '0.0.0-test' }, llm }) as unknown as Host

/** One message in the tab's chat; a sheet that waits is confirmed with the sizes it shows. */
async function ask(host: Host, edition: EditionConfig, session: string, message: string): Promise<PilotEvent[]> {
  const pilot = await tabMimir(host, edition, 'cloud')
  const out: PilotEvent[] = []
  for await (const e of pilot.run(session, message)) {
    out.push(e)
    if (e.type === 'sheet' && e.sheet.fits) void pilot.answerSheet!(e.sheet.id, Object.fromEntries(e.sheet.dims.map((d) => [d.key, d.value])))
  }
  return out
}

const tiers = (sent: LlmHttpRequest[]) => sent.map((r) => r.headers['x-sx-tier'])
const models = (sent: LlmHttpRequest[]) => sent.map((r) => (JSON.parse(r.body) as { model: string }).model)

/** The same edition asking only on hard turns, as layermate's does (stepUp sonnet, everyTurn left out). */
const HARD_TURNS_ONLY: EditionConfig = { ...SLICERX, id: 'layermate', ai: { ...SLICERX.ai, brain: { ...SLICERX.ai.brain, cloud: { stepUp: 'sonnet', everyTurn: 'auto' } } } }

describe('mimir cloud on a fresh SlicerX install', () => {
  const was = { pilot: get().pilot }
  beforeEach(() => {
    resetTabMimir()
    registerMimirCloud({ quota: async () => { throw new Error('not read here') }, forget: async () => 0, register: async () => undefined })
    // nothing set up in Settings > mimir
    set({ pilot: null })
  })
  afterEach(() => {
    resetTabMimir()
    registerMimirCloud(null)
    setCurrentEdition(NEUTRAL)
    set(was)
  })

  it('the edition asks for the stronger model on every turn', () => {
    expect(SLICERX.ai.keySource).toBe('cloud')
    expect(SLICERX.ai.brain.cloud).toEqual({ stepUp: 'sonnet', everyTurn: 'step' })
  })

  it('every request says step: the first build and its sheet, the next run, a follow-up and a question', async () => {
    setCurrentEdition(SLICERX)
    const llm = transport('mimir-cloud', [calls('pilot.sheet', SHEET), said('Built it.')])
    const host = hostWith(llm)
    const build = await ask(host, SLICERX, 'ses_rocket', 'build a toy rocket')
    expect(build.some((e) => e.type === 'sheet')).toBe(true)
    expect(llm.sent.length).toBeGreaterThanOrEqual(2)
    // sizes given as a new message start a run of their own, as do the follow-up and the questions
    await ask(host, SLICERX, 'ses_rocket', 'Use a 6 mm rod instead')
    await ask(host, SLICERX, 'ses_rocket', 'Make it 10 mm taller')
    await ask(host, SLICERX, 'ses_rocket', 'Can the AMS 2 Pro dry nylon?')
    await ask(host, SLICERX, 'ses_question', 'Is my printer online?')
    expect(llm.sent.length).toBeGreaterThanOrEqual(6)
    expect(new Set(llm.sent.map((r) => r.provider))).toEqual(new Set(['mimir-cloud']))
    expect(new Set(tiers(llm.sent))).toEqual(new Set(['step']))
    // the app asks for the base model by name; the proxy picks the turn's model and names it back
    expect(new Set(models(llm.sent))).toEqual(new Set([HAIKU]))
  })

  it('an edition that asks only on hard turns keeps Auto: step for a new part, base for a question or a change', async () => {
    setCurrentEdition(HARD_TURNS_ONLY)
    const llm = transport('mimir-cloud')
    const host = hostWith(llm)
    await ask(host, HARD_TURNS_ONLY, 'ses_a', 'build a toy rocket')
    await ask(host, HARD_TURNS_ONLY, 'ses_b', 'Can the AMS 2 Pro dry nylon?')
    await ask(host, HARD_TURNS_ONLY, 'ses_c', 'Set infill to 20%')
    expect(tiers(llm.sent)).toEqual(['step', 'base', 'base'])
  })

  it('the browser build keeps Auto: its mimir cloud is the proxy\'s web edition', async () => {
    setCurrentEdition(SLICERX)
    const llm = transport('mimir-cloud')
    const host = hostWith(llm, 'web')
    await ask(host, SLICERX, 'ses_a', 'build a toy rocket')
    await ask(host, SLICERX, 'ses_b', 'Can the AMS 2 Pro dry nylon?')
    expect(tiers(llm.sent)).toEqual(['step', 'base'])
  })

  it("a person's own key in Settings > mimir turns it off: no tier header, and Auto's own models", async () => {
    setCurrentEdition(SLICERX)
    set({ pilot: { mode: 'on', provider: 'anthropic' } })
    const llm = transport('anthropic')
    const host = hostWith(llm)
    await ask(host, SLICERX, 'ses_a', 'Can the AMS 2 Pro dry nylon?')
    await ask(host, SLICERX, 'ses_b', 'build a toy rocket')
    expect(tiers(llm.sent)).toEqual([undefined, undefined])
    expect(models(llm.sent)).toEqual([HAIKU, 'claude-sonnet-5-5'])
  })
})
