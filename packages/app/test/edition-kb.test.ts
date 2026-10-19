// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's knowledge base in the app takes the running edition's own index (what the build put in for
// @slicerx/pilot/edition-kb): kb.search finds those docs and cites them as the edition's.
import { DEFAULT_POLICY, type Citation, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG } from '@slicerx/pilot'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NEUTRAL, setCurrentEdition } from '../src/edition'
import { bundledKb } from '../src/features/pilot/kb'

vi.mock('@slicerx/pilot/edition-kb', () => ({
  default: {
    schema: 1,
    docs: [
      {
        kind: 'workflow',
        id: 't-kb-dock_unload',
        name: 'Unloading the test dock',
        aliases: ['dock unload'],
        file: 'knowledge/dock.yaml',
        data: { summary: 'The test dock lifts finished plates off the bed. Empty the drop chute before a long queue.', facts: [{ text: 'Empty the drop chute before a queue of more than eight plates.', src: ['t_kb_manual'] }] },
        sources: ['t_kb_manual'],
        edition: 't-kb-edition',
      },
    ],
    sources: [{ id: 't_kb_manual', title: 'Test dock manual', url: 'https://example.com/dock', edition: 't-kb-edition' }],
    prefixes: [],
    settings: [],
  },
}))

afterEach(() => setCurrentEdition(NEUTRAL))

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => false, stream: () => { throw new Error('scripted') } }

describe("the running edition's own knowledge", () => {
  it('is searched next to the bundled guides and cited as the edition', async () => {
    setCurrentEdition({ ...NEUTRAL, id: 't-kb-edition' })
    const kb = await bundledKb()
    expect(kb.search('drop chute dock unload').map((h) => h.doc.id)).toContain('t-kb-dock_unload')
    expect(kb.cite(['t_kb_manual'])).toEqual([{ id: 't_kb_manual', title: 'Test dock manual', url: 'https://example.com/dock', kind: 'edition' }])
    // bundled guides are still there
    expect(kb.size).toBeGreaterThan(1)

    const client = createScriptedClient([{ calls: [{ name: 'kb.search', args: { query: 'dock unload drop chute' } }] }, { text: 'Done.' }], { chunk: false })
    const pilot = createPilot({ host: { printers, llm: noLlm, approvals: createApprovalBroker() }, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client, kb })
    const events: PilotEvent[] = []
    for await (const ev of pilot.run('kb', 'How do I unload the dock?', {})) events.push(ev)
    const cited: Citation[] = events.flatMap((e) => (e.type === 'citations' ? e.items : []))
    expect(cited).toContainEqual(expect.objectContaining({ id: 't_kb_manual', kind: 'edition' }))
  })

  it('another edition never sees those docs', async () => {
    setCurrentEdition({ ...NEUTRAL, id: 'someone-else' })
    const kb = await bundledKb()
    expect(kb.search('drop chute dock unload').map((h) => h.doc.id)).not.toContain('t-kb-dock_unload')
    expect(kb.cite(['t_kb_manual'])).toEqual([])
  })
})
