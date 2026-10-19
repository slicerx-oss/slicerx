// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The edition's brain pack on mimir, which runs in the mimir tab: a tool group it switched off is never offered there,
// in the desktop app or in the browser build (cad); web off turns web search off too; and its routing names the models
// for the person's own key.
import type { Host, PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, DEFAULT_CONFIG, defineTool, toolGroupOf, type PilotTool } from '@slicerx/pilot'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { NEUTRAL } from '../src/edition'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { editionToolGroups, withBrain } from '../src/pilot-connect/brain'
import { setHostSlices } from '../src/state/model-mode'
import { tabPilotOptions } from '../src/workspaces/mimir/session'

afterEach(() => setHostSlices(true))

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }
const host = { kind: 'web', slicer: {}, printers, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
const withTools = (tools: Partial<Record<'design' | 'slicing' | 'printers' | 'watch' | 'paint' | 'web', boolean>>, routing?: typeof NEUTRAL.ai.brain.routing) => ({ ...NEUTRAL, ai: { ...NEUTRAL.ai, brain: { ...NEUTRAL.ai.brain, tools, ...(routing ? { routing } : {}) } } })

const tool = (name: string) => defineTool({ name, version: '1.0.0', source: 'command', permission: 'read', description: name, input: z.object({}), run: async () => ({ summary: 'ok' }) }) as PilotTool<never>
const DESIGN_TOOLS = [tool('design.new'), tool('geom.info')]

/** The tab's runtime as session.ts makes it, with the edition's switches. */
async function tab(edition: typeof NEUTRAL) {
  return createPilot(tabPilotOptions(host, { llm: noLlm, config: withBrain(DEFAULT_CONFIG, edition), kb: await bundledKb(), tools: DESIGN_TOOLS, commands: [], toolGroups: editionToolGroups(edition) }))
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

  it('the tab never offers a group the edition switched off', async () => {
    const full = groupsOffered(await tab(NEUTRAL))
    expect(full.has('printers')).toBe(true)
    expect(full.has('slicing')).toBe(true)
    expect(full.has('design')).toBe(true)
    const off = await tab(withTools({ printers: false, slicing: false, web: false }))
    const left = groupsOffered(off)
    expect(left.has('printers')).toBe(false)
    expect(left.has('slicing')).toBe(false)
    expect(off.tools().some((t) => t.name === 'web.lookup')).toBe(false)
    // core stays
    expect(left.has('core')).toBe(true)
  })

  it('the tab never offers design tools when design is off', async () => {
    expect((await tab(NEUTRAL)).tools().map((t) => t.name)).toEqual(expect.arrayContaining(['design.new', 'geom.info']))
    const names = (await tab(withTools({ design: false }))).tools().map((t) => t.name)
    expect(names).not.toContain('design.new')
    expect(names).not.toContain('geom.info')
  })

  it('the cad surface (the browser build) never offers a group the edition switched off', async () => {
    setHostSlices(false)
    const on = await tab(NEUTRAL)
    expect(groupsOffered(on).has('design')).toBe(true)
    const off = await tab(withTools({ design: false, web: false }))
    expect(groupsOffered(off).has('design')).toBe(false)
    expect(off.tools().some((t) => t.name === 'web.lookup')).toBe(false)
    expect(off.tools().length).toBeGreaterThan(0)
  })
})
