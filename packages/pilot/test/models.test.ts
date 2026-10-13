// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { createEvalEnv } from '../evals/harness'
import { FRAMES } from '../evals/frames/index'
import { parsePilotConfig } from '../src/config'
import type { PilotEvent } from '@slicerx/contracts'
import { HUGINN, MODEL_AUTOMATIC, MODEL_AUTOMATIC_LABEL, modelFor, modelLabel, MUNINN, tierForPrompt } from '../src/models'
import { createScriptedClient } from '../src/provider/scripted'

const base = { model: 'fallback', models: { huginn: 'quick-vision', muninn: 'deep' } }

describe('huginn and muninn', () => {
  it('sends quick looks to huginn and diagnosis, tuning and planning to muninn', () => {
    expect(tierForPrompt("Hey mimir, how's the print going?")).toBe(HUGINN)
    expect(tierForPrompt('Can the AMS 2 Pro dry nylon?')).toBe(HUGINN)
    expect(tierForPrompt('Why did Bay 4 fail overnight?')).toBe(MUNINN)
    expect(tierForPrompt('Fix the stringing in my PETG profile for good')).toBe(MUNINN)
    expect(tierForPrompt('Get these three orders done by Friday, cheapest printers first')).toBe(MUNINN)
  })

  it('uses the tier model, a pinned model, or huginn for everything on an API key', () => {
    expect(modelFor(base, HUGINN)).toBe('quick-vision')
    expect(modelFor(base, MUNINN)).toBe('deep')
    expect(modelFor({ ...base, modelChoice: MODEL_AUTOMATIC }, MUNINN)).toBe('deep')
    expect(modelFor({ ...base, modelChoice: 'pinned-one' }, HUGINN)).toBe('pinned-one')
    expect(modelFor({ ...base, billing: 'key' }, MUNINN)).toBe('fallback')
    expect(modelFor({ model: 'only' }, MUNINN)).toBe('only')
    expect(MODEL_AUTOMATIC_LABEL).toBe('Automatic (huginn for quick looks, muninn for deep thinking)')
  })

  it('defaults to the plan models for huginn and muninn', async () => {
    const { DEFAULT_CONFIG } = await import('../src/config')
    expect(modelFor({ ...DEFAULT_CONFIG, billing: 'plan' }, HUGINN)).toBe('gpt-5.6-luna')
    expect(modelFor({ ...DEFAULT_CONFIG, billing: 'plan' }, MUNINN)).toBe('gpt-5.6-terra')
    expect(DEFAULT_CONFIG.modelChoice).toBe(MODEL_AUTOMATIC)
  })

  it('reads the tiers, the choice and the billing from pilot.config.json', () => {
    const c = parsePilotConfig({ provider: 'openai', model: 'm', maxSteps: 8, maxToolCalls: 20, models: { huginn: 'a', muninn: 'b' }, modelChoice: 'automatic', billing: 'plan' })
    expect(c.models).toEqual({ huginn: 'a', muninn: 'b' })
    expect(c.billing).toBe('plan')
  })

  it('starts a check-in on huginn and moves to muninn when the run reaches diagnose', async () => {
    const client = createScriptedClient(
      [
        { calls: [{ name: 'check_print', args: { printerId: 'bay-1' } }] },
        { calls: [{ name: 'diagnose', args: { printerId: 'bay-1', symptom: 'corner lifting' } }] },
        { text: 'The corner is lifting.' },
      ],
      { chunk: false },
    )
    const machine = { printer: 'bambu_x1c', material: 'pla', nozzle: 0.4 }
    const env = createEvalEnv({ client, machine, objects: [], frames: { 'bay-1': FRAMES['corner-lifting'] }, config: { models: base.models } })
    for await (const _ of env.pilot.run('t', "How's the print going?", { context: { project: 'eval', machine, objects: [] } })) void _
    expect(client.requests.filter((r) => !r.webSearch).map((r) => r.model)).toEqual(['quick-vision', 'quick-vision', 'deep'])
  })

  it('uses the one API key model for everything on an API key', async () => {
    const client = createScriptedClient([{ calls: [{ name: 'diagnose', args: { symptom: 'layer shift at layer 212' } }] }, { text: 'Belt tension.' }], { chunk: false })
    const machine = { printer: 'bambu_x1c', material: 'pla', nozzle: 0.4 }
    const env = createEvalEnv({ client, machine, objects: [], config: { models: base.models, billing: 'key' } })
    for await (const _ of env.pilot.run('t', 'Why did Bay 4 fail overnight?', { context: { project: 'eval', machine, objects: [] } })) void _
    expect(new Set(client.requests.map((r) => r.model))).toEqual(new Set(['scripted']))
  })

  it('uses the tiers on a key when the person chose Auto, and names the models', () => {
    expect(modelFor({ ...base, billing: 'key', auto: true }, HUGINN)).toBe('quick-vision')
    expect(modelFor({ ...base, billing: 'key', auto: true }, MUNINN)).toBe('deep')
    expect(modelFor({ ...base, billing: 'key', auto: true, modelChoice: 'pinned-one' }, MUNINN)).toBe('pinned-one')
    expect(parsePilotConfig({ provider: 'anthropic', model: 'm', maxSteps: 8, maxToolCalls: 20, auto: true }).auto).toBe(true)
    expect(modelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(modelLabel('some-local-model')).toBe('some-local-model')
  })

  const machine = { printer: 'bambu_x1c', material: 'pla', nozzle: 0.4 }
  const auto = { models: { huginn: 'claude-haiku-5-5', muninn: 'claude-sonnet-5-5' }, billing: 'key' as const, auto: true }
  async function events(env: ReturnType<typeof createEvalEnv>, prompt: string): Promise<PilotEvent[]> {
    const out: PilotEvent[] = []
    for await (const e of env.pilot.run('t', prompt, { context: { project: 'eval', machine, objects: [] } })) out.push(e)
    return out
  }

  it('Auto starts a deep request on muninn and says so once', async () => {
    const client = createScriptedClient([{ calls: [{ name: 'diagnose', args: { symptom: 'layer shift at layer 212' } }] }, { text: 'Belt tension.' }], { chunk: false })
    const env = createEvalEnv({ client, machine, objects: [], config: auto })
    const ev = await events(env, 'Why did Bay 4 fail overnight?')
    expect(client.requests.filter((r) => !r.webSearch).map((r) => r.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5'])
    expect(ev.filter((e) => e.type === 'model_switch')).toEqual([{ type: 'model_switch', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', reason: 'request' }])
  })

  it('Auto moves to muninn after two failed steps on huginn, and when a deep tool comes up', async () => {
    const client = createScriptedClient(
      [{ calls: [{ name: 'no_such_tool', args: {} }] }, { calls: [{ name: 'no_such_tool', args: {} }] }, { text: 'Done.' }],
      { chunk: false },
    )
    const env = createEvalEnv({ client, machine, objects: [], config: auto })
    const ev = await events(env, 'Make me a bracket with two holes')
    expect(client.requests.filter((r) => !r.webSearch).map((r) => r.model)).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'])
    expect(ev.filter((e) => e.type === 'model_switch').map((e) => (e as { reason: string }).reason)).toEqual(['struggle'])

    const tool = createScriptedClient([{ calls: [{ name: 'check_print', args: { printerId: 'bay-1' } }] }, { calls: [{ name: 'diagnose', args: { printerId: 'bay-1', symptom: 'corner lifting' } }] }, { text: 'The corner is lifting.' }], { chunk: false })
    const env2 = createEvalEnv({ client: tool, machine, objects: [], frames: { 'bay-1': FRAMES['corner-lifting'] }, config: auto })
    const ev2 = await events(env2, "How's the print going?")
    expect(ev2.filter((e) => e.type === 'model_switch').map((e) => (e as { reason: string }).reason)).toEqual(['tool'])
  })

  it('Auto on a key weak at building parts moves design work to muninn', async () => {
    const client = createScriptedClient([{ calls: [{ name: 'design.list', args: {} }] }, { text: 'Done.' }], { chunk: false })
    const env = createEvalEnv({ client, machine, objects: [], config: { ...auto, deepDesign: true } })
    const ev = await events(env, 'Make me a bracket with two holes')
    expect(ev.filter((e) => e.type === 'model_switch').map((e) => (e as { reason: string }).reason)).toEqual(['tool'])
    expect(client.requests.filter((r) => !r.webSearch).map((r) => r.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
  })

  it('a key without Auto, and mimir cloud, never switch', async () => {
    const client = createScriptedClient([{ calls: [{ name: 'no_such_tool', args: {} }] }, { calls: [{ name: 'no_such_tool', args: {} }] }, { text: 'Done.' }], { chunk: false })
    const env = createEvalEnv({ client, machine, objects: [], config: { ...auto, auto: false } })
    const ev = await events(env, 'Why did it fail?')
    expect(ev.some((e) => e.type === 'model_switch')).toBe(false)
  })
})
