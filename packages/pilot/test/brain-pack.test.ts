// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An edition's brain pack: its own knowledge next to the bundled one (found, cited as the edition's, and never shown to
// another edition), tool groups it can switch off, and the models it picks for the person's own key. mimir cloud keeps
// taking its model from the proxy whatever the edition routes.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotConfig, type PrinterHost } from '@slicerx/contracts'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createEvalEnv } from '../evals/harness'
import { editionKnowledge } from '../scripts/build-kb'
import { DEFAULT_CONFIG } from '../src/config'
import kbIndex from '../src/kb/generated/kb.json' with { type: 'json' }
import { createKnowledgeBase, type KbIndex } from '../src/kb/kb'
import { HUGINN, modelFor, MUNINN } from '../src/models'
import { createScriptedClient } from '../src/provider/scripted'
import { createPilot } from '../src/runtime'
import { applyToolGroups, toolGroupOf } from '../src/surfaces'

const BASE = kbIndex as unknown as KbIndex
const HARBOR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'brain-pack', 'harbor', 'edition.config.ts')

function registry(): string[] {
  const env = createEvalEnv({ client: createScriptedClient([{ text: 'ok' }]), machine: { printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }, objects: [], scope: 'full' })
  return env.pilot.registry().map((t) => t.name)
}

describe('tool groups', () => {
  it('printers off removes every printer tool', () => {
    const tools = [...registry(), 'printer_add', 'printer_discover', 'spoolman.list_spools'].map((name) => ({ name }))
    const names = applyToolGroups(tools, { printers: false }).map((t) => t.name)
    for (const name of ['printer.list', 'printer.status', 'printer.queue', 'printer.history', 'printer_setup', 'printer_add', 'printer_discover', 'fleet_overview', 'schedule', 'spool_inventory', 'spoolman.list_spools']) {
      expect(names, name).not.toContain(name)
    }
    expect(names.filter((n) => toolGroupOf(n) === 'printers')).toEqual([])
    // everything outside the group stays, in order
    expect(names).toEqual(tools.map((t) => t.name).filter((n) => toolGroupOf(n) !== 'printers'))
    expect(names).toContain('kb.search')
    expect(names).toContain('slice')
  })

  it('groups cannot add tools', () => {
    const tools = ['kb.search', 'slice', 'printer.status'].map((name) => ({ name }))
    expect(applyToolGroups(tools, { design: true, printers: true, web: true })).toEqual(tools)
    expect(applyToolGroups(tools, undefined)).toEqual(tools)
    // a key the schema would refuse switches nothing, on or off
    expect(applyToolGroups(tools, { core: false, cad: true } as never)).toEqual(tools)
    expect(toolGroupOf('kb.search')).toBe('core')
    expect(toolGroupOf('pilot.ask')).toBe('core')
    expect(toolGroupOf('constructor')).toBe('core')
  })
})

describe("an edition's own knowledge", () => {
  it('edition docs are found and cited', async () => {
    const { index, problems } = await editionKnowledge(HARBOR)
    expect(problems).toEqual([])
    expect(index.docs.map((d) => [d.id, d.edition])).toEqual([['harbor_dock_unload', 'harbor']])
    const kb = createKnowledgeBase(BASE, { id: 'harbor', index })
    const top = kb.search('drop chute dock queue')[0]
    expect(top?.doc).toMatchObject({ id: 'harbor_dock_unload', edition: 'harbor' })
    expect(kb.cite(top?.doc.sources ?? [])).toEqual([{ id: 'harbor_dock_manual', title: 'Harbor Dock manual', url: 'https://docs.harborprint.example/dock', publisher: 'Harbor Print', kind: 'edition' }])
    expect(kb.get('workflow', 'dock unload')?.edition).toBe('harbor')
    // the bundled knowledge is still there and still cites as the knowledge base
    const petg = kb.get('filament', 'petg')
    expect(petg?.edition).toBeUndefined()
    expect(kb.cite(petg?.sources ?? []).every((c) => c.kind === 'kb')).toBe(true)
    expect(kb.size).toBe(BASE.docs.length + 1)
  })

  it("SlicerX search never returns another edition's docs", async () => {
    const { index } = await editionKnowledge(HARBOR)
    // even an index that mixes editions, or bundled docs tagged with one
    const mixed: KbIndex = { ...BASE, docs: [...BASE.docs, ...index.docs], sources: [...BASE.sources, ...index.sources] }
    for (const kb of [createKnowledgeBase(BASE, { id: 'slicerx', index }), createKnowledgeBase(BASE), createKnowledgeBase(mixed, { id: 'slicerx', index: { ...index, docs: [] } })]) {
      expect(kb.search('drop chute dock queue harbor', { limit: 50 }).filter((h) => h.doc.edition !== undefined)).toEqual([])
      expect(kb.get('workflow', 'harbor_dock_unload')).toBeUndefined()
      expect(kb.cite(['harbor_dock_manual'])).toEqual([])
      expect(kb.size).toBe(BASE.docs.length)
    }
  })
})

describe('model routing', () => {
  const own: PilotConfig = { ...DEFAULT_CONFIG, provider: 'openai', model: 'gpt-6-sol', billing: 'key', routing: { provider: 'openai', base: 'gpt-6-luna', step: 'gpt-6-sol' } }

  it('routing picks openai base for an own key when set', () => {
    expect(modelFor(own, HUGINN)).toBe('gpt-6-luna')
    expect(modelFor(own, MUNINN)).toBe('gpt-6-luna')
    expect(modelFor({ ...own, auto: true }, HUGINN)).toBe('gpt-6-luna')
    expect(modelFor({ ...own, auto: true }, MUNINN)).toBe('gpt-6-sol')
    // unset, or for the other provider's key, the config's own model stays
    const { routing: _, ...plain } = own
    expect(modelFor(plain, HUGINN)).toBe('gpt-6-sol')
    expect(modelFor({ ...own, routing: { provider: 'anthropic', base: 'claude-haiku-5-5' } }, HUGINN)).toBe('gpt-6-sol')
    // the person's pinned model still wins
    expect(modelFor({ ...own, modelChoice: 'gpt-6-sol' }, HUGINN)).toBe('gpt-6-sol')
  })

  it('cloud ignores routing', async () => {
    const HAIKU = 'claude-haiku-5-5'
    const cloud: PilotConfig = { ...DEFAULT_CONFIG, provider: 'mimir-cloud', model: HAIKU, baseUrl: 'https://abcdefghijklmnop.supabase.co/functions/v1/mimir', billing: 'key', webSearch: false, routing: { provider: 'anthropic', base: 'claude-opus-5-5', step: 'claude-opus-5-5' } }
    expect(modelFor(cloud, HUGINN)).toBe(HAIKU)
    expect(modelFor(cloud, MUNINN)).toBe(HAIKU)
    expect(modelFor({ ...cloud, routing: { base: 'claude-opus-5-5' } }, HUGINN)).toBe(HAIKU)

    // the request still names the edition's model and asks the proxy by tier only
    const sent: { model: string; tier: string | undefined }[] = []
    const t: LlmTransport = {
      available: async () => true,
      async *stream(req) {
        sent.push({ model: (JSON.parse(req.body) as { model: string }).model, tier: req.headers['x-sx-tier'] })
        const done = [
          { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]
        yield new TextEncoder().encode(done.map((d) => `event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`).join(''))
      },
    }
    const pilot = createPilot({
      host: { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as unknown as ApprovalHost, llm: t },
      config: cloud,
      policy: DEFAULT_POLICY,
      builtins: false,
      tools: [],
    })
    for (const message of ['Can the AMS 2 Pro dry nylon?', 'Why did my print fail?']) for await (const _ of pilot.run(`ses_${message.length}`, message)) void _
    expect(sent).toEqual([
      { model: HAIKU, tier: 'base' },
      { model: HAIKU, tier: 'step' },
    ])
  })
})
