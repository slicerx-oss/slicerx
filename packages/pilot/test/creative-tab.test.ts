// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The creative eval runs mimir with the mimir tab's options (tab-options.ts, the code the app's tab uses): the same
// step and tool call limits, the edition's tool groups and the scope rule. A reply that builds nothing is scored as
// asked, declined or none, and a clarifying question gets one default answer before the run is scored.
import { DEFAULT_POLICY } from '@slicerx/contracts'
import { neutralEdition } from '@slicerx/edition-config'
import { describe, expect, it } from 'vitest'
import { CREATIVE_PROMPTS } from '../evals/creative/prompts'
import { loadRecording } from '../evals/creative/recordings'
import { CREATIVE_TAB, classifyNoBuild, creativeEnv, DEFAULT_ANSWER, runPrompt } from '../evals/creative/run'
import { CAD_TOOLS, createPilot } from '../src/runtime'
import { createScriptedClient } from '../src/provider/scripted'
import { editionToolGroups, tabOptions, tabScope, TAB_MIN_STEPS, TAB_MIN_TOOL_CALLS, withBrain } from '../src/tab-options'

const P = CREATIVE_PROMPTS.find((x) => x.id === 'cable-organizer')!
const stub = () => createScriptedClient([{ text: 'ok' }], { chunk: false })

describe('the tab options the app and the creative eval share', () => {
  it('raise the step and tool call limits to the tab floor and keep higher ones', () => {
    const low = tabOptions({ slices: true, config: { provider: 'p', model: 'm', maxSteps: 24, maxToolCalls: 40 }, kb: creativeEnv(P, stub()).kb, tools: [], commands: [] })
    expect(low.config).toMatchObject({ maxSteps: TAB_MIN_STEPS, maxToolCalls: TAB_MIN_TOOL_CALLS })
    expect([TAB_MIN_STEPS, TAB_MIN_TOOL_CALLS]).toEqual([40, 60])
    const high = tabOptions({ slices: true, config: { provider: 'p', model: 'm', maxSteps: 50, maxToolCalls: 90 }, kb: creativeEnv(P, stub()).kb, tools: [], commands: [] })
    expect(high.config).toMatchObject({ maxSteps: 50, maxToolCalls: 90 })
  })

  it('take the cad scope only where the host does not slice', () => {
    expect(tabScope(true)).toBeUndefined()
    expect(tabScope(false)).toBe('cad')
  })

  it('give the creative eval the desktop tab: limits, scope, surface, policy and the default edition groups', () => {
    expect(CREATIVE_TAB.slices).toBe(true)
    const env = creativeEnv(P, stub())
    expect(env.options.config).toMatchObject({ maxSteps: TAB_MIN_STEPS, maxToolCalls: TAB_MIN_TOOL_CALLS })
    expect(env.options.scope).toBeUndefined()
    expect(env.options.surface).toBe('tab')
    expect(env.options.policy).toBe(DEFAULT_POLICY)
    expect(env.options.toolGroups).toEqual(editionToolGroups(neutralEdition()))
    expect(env.options.config.webSearch).toBe(withBrain({ ...env.options.config }, neutralEdition()).webSearch)
  })

  it('offer the creative eval the tools a runtime made from the tab options offers', () => {
    const env = creativeEnv(P, stub())
    const direct = createPilot({ ...env.options, ...tabOptions({ slices: true, config: env.options.config, kb: env.kb, tools: [], commands: [], toolGroups: editionToolGroups(neutralEdition()) }) })
    expect(env.pilot.tools().map((t) => t.name).sort()).toEqual(direct.tools().map((t) => t.name).sort())
  })

  it('run the browser build in the cad scope when it does not slice', () => {
    const env = creativeEnv(P, stub(), {}, { slices: false })
    expect(env.options.scope).toBe('cad')
    for (const t of env.pilot.tools()) expect(CAD_TOOLS.has(t.name) || t.name.startsWith('app.') || t.name.startsWith('memory.'), t.name).toBe(true)
  })
})

describe('a reply that builds nothing', () => {
  const text = (id: string): string => {
    const rec = loadRecording(id)
    return rec.status === 'recorded' ? rec.steps.map((s) => s.text ?? '').join('\n') : ''
  }

  it('is declined when it says the part cannot be modeled or built', () => {
    expect(classifyNoBuild(text('taco'))).toBe('declined')
    expect(classifyNoBuild(text('flexi-fish'))).toBe('declined')
    expect(classifyNoBuild(text('ship-hull'))).toBe('declined')
    expect(classifyNoBuild("I can't build a knitted surface. Want ribs instead?")).toBe('declined')
  })

  it('is asked when it puts a question to the person and does not decline', () => {
    expect(classifyNoBuild(text('gear-pair'))).toBe('asked')
    expect(classifyNoBuild(text('phone-stand'))).toBe('asked')
    expect(classifyNoBuild('How tall should it be?')).toBe('asked')
  })

  it('is none when it neither asks nor declines', () => {
    expect(classifyNoBuild('')).toBe('none')
    expect(classifyNoBuild('Here is a dragon.')).toBe('none')
    // cut off mid list: no question and no refusal
    expect(classifyNoBuild(text('pip-chain'))).toBe('none')
  })

  it('is scored with its reason instead of a plain parse failure', async () => {
    const run = await runPrompt(P, { geom: undefined, steps: [{ text: "I can't model that." }] })
    expect(run.noBuild).toBe('declined')
    expect(run.parsed).toEqual({ pass: false, detail: 'no design tool was called: declined' })
  })
})

describe('the default answer to a clarifying question', () => {
  const build = { calls: [{ name: 'make_model', args: { name: 'Cable organizer', parts: [{ kind: 'box', name: 'base', sizeMm: [100, 30, 20] }] } }] }

  it('answers a question once and lets the model build', async () => {
    const client = createScriptedClient([{ text: 'How long should the organizer be?' }, build, { text: 'Built it.' }], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client })
    expect(run.answered).toBe(true)
    expect(run.calls).toContain('make_model')
    expect(run.noBuild).toBeUndefined()
    const answer = client.requests[1]?.messages.at(-1)
    expect(answer?.role).toBe('user')
    expect(String(answer?.content)).toContain(DEFAULT_ANSWER)
    expect(DEFAULT_ANSWER).toBe('Use common sizes and sensible defaults, then build it')
  })

  it('answers only once: a second question is scored as asked', async () => {
    const client = createScriptedClient([{ text: 'How long?' }, { text: 'And how wide?' }, build], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client })
    expect(run.answered).toBe(true)
    expect(run.noBuild).toBe('asked')
    expect(client.requests).toHaveLength(2)
  })

  it('never answers a decline', async () => {
    const client = createScriptedClient([{ text: "I can't model a sculpted dragon. Which version do you want?" }, build], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client })
    expect(run.answered).toBe(false)
    expect(run.noBuild).toBe('declined')
    expect(client.requests).toHaveLength(1)
  })

  it('is off with defaultAnswer false', async () => {
    const client = createScriptedClient([{ text: 'How long should it be?' }, build], { chunk: false })
    const run = await runPrompt(P, { geom: undefined, client, defaultAnswer: false })
    expect(run.answered).toBe(false)
    expect(run.noBuild).toBe('asked')
    expect(client.requests).toHaveLength(1)
  })

  it('replays the answer only for a recording captured with it, and marks an older question stale', async () => {
    const asked = loadRecording('gear-pair')
    if (asked.status !== 'recorded') throw new Error('gear-pair has a recording')
    const old = await runPrompt(CREATIVE_PROMPTS.find((x) => x.id === 'gear-pair')!, { geom: undefined, steps: asked.steps })
    expect(old.answered).toBe(false)
    expect(old.noBuild).toBe('asked')
    expect(old.stale).toMatch(/default answer/)
    const fresh = await runPrompt(P, { geom: undefined, steps: [{ text: 'How long?' }, build, { text: 'Done.' }], answerRecorded: true })
    expect(fresh.answered).toBe(true)
    expect(fresh.calls).toContain('make_model')
    expect(fresh.stale).toBeUndefined()
  })
})
