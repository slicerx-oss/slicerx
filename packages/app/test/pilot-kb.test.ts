// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, type KnowledgeBase } from '@slicerx/pilot'
import { bundledKb } from '../src/features/pilot/kb'

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => false, stream: () => { throw new Error('scripted') } }

// The guide lookups the built-in demo model makes.
const DEMO_LOOKUPS = [
  { name: 'kb.troubleshoot', args: { symptom: 'layer shift' } },
  { name: 'kb.filament', args: { material: 'PETG' } },
  { name: 'kb.intent', args: { text: 'Print 12 strong PETG brackets by Friday, cheapest printers first.' } },
]

async function lookups(kb?: KnowledgeBase) {
  const client = createScriptedClient([{ calls: DEMO_LOOKUPS }, { text: 'Done.' }], { chunk: false })
  const pilot = createPilot({ host: { printers, llm: noLlm, approvals: createApprovalBroker() }, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client, ...(kb ? { kb } : {}) })
  const events: PilotEvent[] = []
  for await (const ev of pilot.run('kb', 'guides', {})) events.push(ev)
  return events
}

describe('the bundled knowledge base', () => {
  it('loads once and holds the guides', async () => {
    const kb = await bundledKb()
    expect(kb).toBe(await bundledKb())
    expect(kb.size).toBeGreaterThan(0)
    expect(kb.all('troubleshoot').length).toBeGreaterThan(0)
  })

  it('answers the demo model guide lookups and cites them', async () => {
    const events = await lookups(await bundledKb())
    const results = events.flatMap((e) => (e.type === 'tool_result' ? [e] : []))
    expect(results).toHaveLength(DEMO_LOOKUPS.length)
    expect(results.filter((r) => !r.ok).map((r) => r.summary)).toEqual([])
    const cited = events.flatMap((e) => (e.type === 'citations' ? e.items : []))
    expect(cited.length).toBeGreaterThan(0)
  })

  it('is what the lookups need: without it they fail', async () => {
    const events = await lookups()
    const results = events.flatMap((e) => (e.type === 'tool_result' ? [e] : []))
    expect(results.some((r) => !r.ok)).toBe(true)
  })
})
