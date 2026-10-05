// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { createEvalEnv } from '../evals/harness'
import { FRAMES } from '../evals/frames/index'
import { parsePilotConfig } from '../src/config'
import { HUGINN, MODEL_AUTOMATIC, MODEL_AUTOMATIC_LABEL, modelFor, MUNINN, tierForPrompt } from '../src/models'
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
})
