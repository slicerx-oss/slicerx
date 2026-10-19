// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The edition's brain pack on every mimir the app makes: a tool group it switched off is never offered in the dock,
// the browser's cad dock or the mimir tab; web off turns web search off too; and its routing names the models for the
// person's own key.
import type { Host, PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, DEFAULT_CONFIG, defineTool, toolGroupOf, type PilotTool } from '@slicerx/pilot'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { NEUTRAL } from '../src/edition'
import { bundledKb } from '../src/features/pilot/kb'
import { dockPilotOptions } from '../src/features/pilot/use-pilot'
import { editionToolGroups, withBrain } from '../src/pilot-connect/brain'
import { setHostSlices } from '../src/state/model-mode'
import { tabPilotOptions } from '../src/workspaces/mimir/session'

afterEach(() => setHostSlices(true))

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }
const host = { kind: 'web', slicer: {}, printers, capabilities: { threads: 1 } } as unknown as Host
const withTools = (tools: Partial<Record<'design' | 'slicing' | 'printers' | 'watch' | 'paint' | 'web', boolean>>, routing?: typeof NEUTRAL.ai.brain.routing) => ({ ...NEUTRAL, ai: { ...NEUTRAL.ai, brain: { ...NEUTRAL.ai.brain, tools, ...(routing ? { routing } : {}) } } })

async function dock(edition: typeof NEUTRAL) {
  const options = dockPilotOptions(host, { printers, llm: noLlm, approvals: createApprovalBroker(), config: withBrain(DEFAULT_CONFIG, edition), kb: await bundledKb() })
  return createPilot({ ...options, toolGroups: editionToolGroups(edition) })
}

const groupsOffered = (pilot: ReturnType<typeof createPilot>): Set<string> => {
  const offered = new Set(pilot.tools().map((t) => t.name))
  return new Set(pilot.registry().filter((t) => offered.has(t.name)).map((t) => toolGroupOf(t)))
}

describe("the edition's brain pack", () => {
  it('carries only the groups switched off, and web off turns web search off', () => {
    expect(editionToolGroups(withTools({ printers: false, design: true }))).toEqual({ printers: false })
    expect(editionToolGroups(NEUTRAL)).toEqual({})
    expect(withBrain(DEFAULT_CONFIG, withTools({ web: false })).webSearch).toBe(false)
    expect(withBrain({ ...DEFAULT_CONFIG, webSearch: true }, withTools({})).webSearch).toBe(true)
  })

  it('routing from ai.brain.routing lands on the config; none leaves it unset', () => {
    expect(withBrain(DEFAULT_CONFIG, withTools({}, { provider: 'openai', base: 'gpt-small', step: 'gpt-large' })).routing).toEqual({ provider: 'openai', base: 'gpt-small', step: 'gpt-large' })
    expect(withBrain(DEFAULT_CONFIG, NEUTRAL).routing).toBeUndefined()
  })

  it('the dock never offers a group the edition switched off', async () => {
    const full = groupsOffered(await dock(NEUTRAL))
    expect(full.has('printers')).toBe(true)
    expect(full.has('slicing')).toBe(true)
    const off = await dock(withTools({ printers: false, slicing: false, web: false }))
    const left = groupsOffered(off)
    expect(left.has('printers')).toBe(false)
    expect(left.has('slicing')).toBe(false)
    expect(off.tools().some((t) => t.name === 'web.lookup')).toBe(false)
    // core stays
    expect(left.has('core')).toBe(true)
  })

  it("the browser's cad dock never offers design tools when design is off", async () => {
    setHostSlices(false)
    const on = await dock(NEUTRAL)
    expect(groupsOffered(on).has('design')).toBe(true)
    const off = await dock(withTools({ design: false }))
    expect(groupsOffered(off).has('design')).toBe(false)
    expect(off.tools().length).toBeGreaterThan(0)
  })

  it('the mimir tab never offers design tools when design is off', async () => {
    const tool = (name: string) => defineTool({ name, version: '1.0.0', source: 'command', permission: 'read', description: name, input: z.object({}), run: async () => ({ summary: 'ok' }) }) as PilotTool<never>
    const tools = [tool('design.new'), tool('geom.info')]
    const kb = await bundledKb()
    const make = (edition: typeof NEUTRAL) => createPilot(tabPilotOptions({ llm: noLlm, config: withBrain(DEFAULT_CONFIG, edition), kb, tools, toolGroups: editionToolGroups(edition) }))
    expect(make(NEUTRAL).tools().map((t) => t.name)).toEqual(expect.arrayContaining(['design.new', 'geom.info']))
    const names = make(withTools({ design: false })).tools().map((t) => t.name)
    expect(names).not.toContain('design.new')
    expect(names).not.toContain('geom.info')
  })
})
