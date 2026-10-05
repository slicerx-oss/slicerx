// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir on the phone answers its guide lookups from the bundled knowledge base and cites them.
import { DEFAULT_POLICY, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, type KnowledgeBase } from '@slicerx/pilot'
import { bundledKb } from './kb'

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => false, stream: () => { throw new Error('scripted') } }

const LOOKUPS = [
  { name: 'kb.troubleshoot', args: { symptom: 'layer shift' } },
  { name: 'kb.filament', args: { material: 'PETG' } },
]

async function lookups(kb?: KnowledgeBase): Promise<PilotEvent[]> {
  const client = createScriptedClient([{ calls: LOOKUPS }, { text: 'Done.' }], { chunk: false })
  const pilot = createPilot({ host: { printers, llm: noLlm, approvals: createApprovalBroker() }, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client, ...(kb ? { kb } : {}) })
  const events: PilotEvent[] = []
  for await (const ev of pilot.run('kb', 'guides', {})) events.push(ev)
  return events
}

describe('the bundled knowledge base on the phone', () => {
  it('is built once and holds the guides', () => {
    expect(bundledKb()).toBe(bundledKb())
    expect(bundledKb().all('troubleshoot').length).toBeGreaterThan(0)
  })

  it('answers guide lookups and cites them', async () => {
    const events = await lookups(bundledKb())
    const results = events.flatMap((e) => (e.type === 'tool_result' ? [e] : []))
    expect(results).toHaveLength(LOOKUPS.length)
    expect(results.filter((r) => !r.ok).map((r) => r.summary)).toEqual([])
    expect(events.some((e) => e.type === 'citations' && e.items.length > 0)).toBe(true)
  })

  it('is what the lookups need: without it they fail', async () => {
    const results = (await lookups()).flatMap((e) => (e.type === 'tool_result' ? [e] : []))
    expect(results.some((r) => !r.ok)).toBe(true)
  })
})
