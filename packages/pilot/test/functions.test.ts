// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The deterministic jobs run as plain functions, and mimir keeps only
// the skills a settings panel cannot do.
import { describe, expect, it } from 'vitest'
import { createEvalEnv, createEvalSlicer, evalKb } from '../evals/harness'
import { sampleGcode } from '../evals/skills/b'
import { createScriptedClient } from '../src/provider/scripted'
import { APP_FUNCTIONS, appFunctionSpecs, preflight, runAppFunction } from '../src/functions'
import { createShared } from '../src/shared'
import { builtinTools } from '../src/tools/index'
import { SKILL_TOOLS } from '../skills/catalog'
import { SKILL_INFO, SKILL_NAMES } from '../skills/index'

function env() {
  const e = createEvalEnv({ client: createScriptedClient([]), machine: { printer: 'bambu_p1s', material: 'petg', nozzle: 0.4 }, objects: [{ id: 'lid', name: 'Lid', bboxMm: [80, 80, 12] }] })
  return { host: { printers: e.sim, slicer: createEvalSlicer(() => e.project) }, project: e.project, kb: e.kb, today: '2026-09-30' }
}

describe('mimir skill list', () => {
  it('has about 15 skills, matching the catalog and SKILL_INFO', () => {
    const catalog = evalKb().skills().map((s) => s.id)
    expect(catalog.length).toBeGreaterThanOrEqual(12)
    expect(catalog.length).toBeLessThanOrEqual(16)
    expect([...SKILL_NAMES].sort()).toEqual([...catalog].sort())
    expect(Object.keys(SKILL_TOOLS).sort()).toEqual([...catalog].sort())
    for (const s of SKILL_INFO) expect(s.example.length, s.name).toBeGreaterThan(10)
  })

  it('offers mimir none of the deterministic checks', () => {
    const names = new Set(builtinTools({ planner: undefined, commands: [], shared: createShared() }).map((t) => t.name))
    for (const fn of APP_FUNCTIONS) expect(names.has(fn), fn).toBe(false)
    for (const gone of ['quote', 'order_to_queue', 'remix', 'first_layer_watch', 'spaghetti_policy', 'maintenance', 'drying_planner', 'profile_certify']) expect(names.has(gone), gone).toBe(false)
  })

  it('registers every tool the kept skills name', () => {
    const names = new Set(builtinTools({ planner: undefined, commands: [], shared: createShared() }).map((t) => t.name))
    for (const [skill, tools] of Object.entries(SKILL_TOOLS)) for (const t of tools) expect(names.has(t), `${skill}: ${t}`).toBe(true)
  })
})

describe('app functions', () => {
  it('describe themselves for forms', () => {
    const specs = appFunctionSpecs()
    expect(specs.map((s) => s.name).sort()).toEqual([...APP_FUNCTIONS].sort())
    for (const s of specs) expect(['read', 'slice']).toContain(s.permission)
  })

  it('refuse unknown names and bad input without throwing', async () => {
    expect(await runAppFunction('quote', {}, env())).toMatchObject({ ok: false, summary: 'Unknown function quote' })
    const bad = await runAppFunction('printer_config_check', { printerId: '' }, env())
    expect(bad.ok).toBe(false)
    expect(bad.summary).toMatch(/^Bad input for printer_config_check/)
  })

  it('lints pasted G-code with no model and no key', async () => {
    const r = await runAppFunction('gcode_inspect', { text: sampleGcode({ layer: 0.2, speed: 60, nozzle: 245, bed: 70, retract: 0.8 }) }, env())
    expect(r.ok).toBe(true)
    expect(r.summary.length).toBeGreaterThan(0)
  })

  it('runs the send preflight as three separate results', async () => {
    const r = await preflight({ printerId: 'bay-2', gcode: sampleGcode({ layer: 0.2, speed: 60, nozzle: 245, bed: 70, retract: 0.8 }) }, env())
    expect(r.checks.map((c) => c.name)).toEqual(['gcode_inspect', 'printer_config_check', 'spool_fit'])
    expect(r.checks[0]?.result.ok).toBe(true)
    expect(r.checks[1]?.result.ok).toBe(true)
    expect(r.ok).toBe(r.checks.every((c) => c.result.ok))
  })
})
