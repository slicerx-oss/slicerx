// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What mimir remembers about the person: no secrets are kept, the notes it reads fit the budget and lead with the
// printer asked about, the edition can turn memory off, and saving a note always asks first.
import { DEFAULT_POLICY, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { estimateTokens, factLine, pickFacts, redactSecrets, type MemoryFact, type MemoryStore } from '../src/memory/facts'
import { createApprovalBroker } from '../src/permit/broker'
import { DEFAULT_CONFIG } from '../src/config'
import type { LlmMessage } from '../src/provider/types'
import { createScriptedClient, type ScriptStep } from '../src/provider/scripted'
import { createPilot } from '../src/runtime'

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => false, stream: () => { throw new Error('scripted') } }

function rows(): MemoryStore & { rows: Map<string, MemoryFact> } {
  const rows = new Map<string, MemoryFact>()
  return {
    rows,
    list: async () => [...rows.values()],
    put: async (f) => void rows.set(f.id, f),
    remove: async (id) => void rows.delete(id),
    clear: async () => rows.clear(),
  }
}

const fact = (id: string, kind: MemoryFact['kind'], text: string, updatedAt: number, data?: MemoryFact['data']): MemoryFact => ({ id, kind, text, updatedAt, ...(data ? { data } : {}) })

function pilotWith(steps: ScriptStep[], memory: { local: boolean; store: MemoryStore }) {
  return createPilot({ host: { printers, llm: noLlm, approvals: createApprovalBroker() }, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), memory })
}

describe('secrets never become notes', () => {
  it('an access code is refused', () => {
    const r = redactSecrets('My A1 access code is 31415926')
    expect(r.refused).toBe(true)
    expect(r.text).not.toContain('31415926')
    expect(redactSecrets('Serial 01P00A123456789 is in the garage').refused).toBe(true)
    expect(redactSecrets('Prints PETG at 240 C on the A1').refused).toBe(false)
  })

  it('an sk- key is refused', () => {
    // built here so the source itself never holds a key's shape (hygiene.test.ts)
    const r = redactSecrets(`use ${['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz0123'].join('-')} for the cloud`)
    expect(r.refused).toBe(true)
    expect(r.text).not.toContain('abcdefghijklmnopqrstuvwxyz0123')
  })
})

describe('which notes mimir reads', () => {
  it('pickFacts stays under 800 tokens with 200 facts', () => {
    const facts = Array.from({ length: 200 }, (_, i) => fact(`f${i}`, i % 2 ? 'outcome' : 'filament', `Note ${i}: Polymaker PLA Pro on the A1 printed well at 215 C with 0.2 mm layers and the textured plate`, i))
    const picked = pickFacts(facts, 'PLA on the A1')
    expect(picked.length).toBeGreaterThan(0)
    expect(picked.length).toBeLessThan(200)
    expect(picked.reduce((n, f) => n + estimateTokens(factLine(f)), 0)).toBeLessThanOrEqual(800)
    expect(picked.map(factLine).join('\n').length / 4).toBeLessThanOrEqual(800)
  })

  it('facts for the printer in the question rank first', () => {
    const facts = [
      fact('a1', 'printer', 'Bambu Lab A1 with the 0.4 mm nozzle', 30, { model: 'A1' }),
      fact('pla', 'filament', 'Mostly prints Polymaker PLA', 20),
      fact('mk4s', 'printer', 'Prusa MK4S in the shed', 10, { model: 'MK4S' }),
      fact('petg', 'outcome', 'PETG on the MK4S worked at 240 C with the fan at 30 percent', 5),
    ]
    const picked = pickFacts(facts, 'Why is my MK4S stringing?')
    expect(picked.slice(0, 2).map((f) => f.id).sort()).toEqual(['mk4s', 'petg'])
    expect(picked.map((f) => f.id)).toContain('a1')
  })

  it("the person's notes ride on the first message only", async () => {
    const store = rows()
    await store.put(fact('mk4s', 'printer', 'Prusa MK4S in the shed', 1))
    const seen: string[] = []
    const look = (m: LlmMessage[]) => {
      seen.push(String(m.at(-1)?.content))
      return { text: 'Noted.' }
    }
    const pilot = pilotWith([look, look], { local: true, store })
    for await (const _ of pilot.run('s', 'Is my MK4S ready?')) void _
    for await (const _ of pilot.run('s', 'And now?')) void _
    expect(seen[0]).toContain('What you know about this person')
    expect(seen[0]).toContain('- Prusa MK4S in the shed')
    expect(seen[0]!.indexOf('Permissions:')).toBeLessThan(seen[0]!.indexOf('What you know about this person'))
    expect(seen[1]).not.toContain('What you know about this person')
  })
})

describe('memory tools', () => {
  it('memory off registers no tools', async () => {
    const store = rows()
    await store.put(fact('mk4s', 'printer', 'Prusa MK4S in the shed', 1))
    const seen: string[] = []
    const pilot = pilotWith([(m) => (seen.push(String(m.at(-1)?.content)), { text: 'Ok.' })], { local: false, store })
    expect(pilot.registry().filter((t) => t.name.startsWith('memory.'))).toEqual([])
    for await (const _ of pilot.run('s', 'Is my MK4S ready?')) void _
    expect(seen[0]).not.toContain('MK4S in the shed')
    const on = pilotWith([], { local: true, store })
    expect(on.registry().map((t) => t.name).filter((n) => n.startsWith('memory.')).sort()).toEqual(['memory.recall', 'memory.remember'])
    expect(on.registry().find((t) => t.name === 'memory.recall')?.permission).toBe('read')
  })

  it('remember asks before saving', async () => {
    const store = rows()
    const steps: ScriptStep[] = [{ calls: [{ name: 'memory.remember', args: { kind: 'printer', text: 'Has a Bambu Lab A1', data: { model: 'A1' } } }] }, { text: 'Saved.' }]
    const pilot = pilotWith(steps, { local: true, store })
    const events: PilotEvent[] = []
    let asked = 0
    for await (const ev of pilot.run('s', 'Remember that I have an A1')) {
      events.push(ev)
      if (ev.type === 'approval_request') {
        asked++
        expect(ev.request.permission).toBe('profile')
        expect(store.rows.size).toBe(0)
        await pilot.resolveApproval(ev.request.id, { kind: 'approve' })
      }
    }
    expect(asked).toBe(1)
    expect([...store.rows.values()]).toMatchObject([{ kind: 'printer', text: 'Has a Bambu Lab A1', data: { model: 'A1' } }])

    // a declined card saves nothing, and a secret is refused before any card
    const none = rows()
    const denied = pilotWith(steps, { local: true, store: none })
    for await (const ev of denied.run('s', 'Remember that I have an A1')) if (ev.type === 'approval_request') await denied.resolveApproval(ev.request.id, { kind: 'deny' })
    expect(none.rows.size).toBe(0)
    const secret = pilotWith([{ calls: [{ name: 'memory.remember', args: { kind: 'printer', text: 'A1 access code is 31415926' } }] }, { text: 'No.' }], { local: true, store: none })
    const evs: PilotEvent[] = []
    for await (const ev of secret.run('s', 'Remember my code')) evs.push(ev)
    expect(evs.some((e) => e.type === 'approval_request')).toBe(false)
    expect(none.rows.size).toBe(0)
  })
})
