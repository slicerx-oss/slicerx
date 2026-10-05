// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plan and validate outputs both languages must reproduce. Run with UPDATE_GOLDEN=1 to rewrite
// fixtures/plan-configs.json, plan-golden.json and validate-golden.json from this implementation.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CalibrationResult, PlanIntent, PrintConfig, SetupRef } from '@slicerx/contracts/settings'
import { mergeConfigs } from './import'
import { planSettings } from './plan'
import { loadProfile } from './testkit'
import { validate } from './validate'

const dir = fileURLToPath(new URL('../fixtures/', import.meta.url))
const read = (name: string): unknown => JSON.parse(readFileSync(dir + name, 'utf8'))
const update = process.env['UPDATE_GOLDEN'] === '1'

interface Case {
  name: string
  from: SetupRef
  to: SetupRef
  base: boolean | string
  options: { intent?: PlanIntent; calibrations?: CalibrationResult[]; keep?: string[]; tuned?: string[]; target?: string }
}

const merged = (filament: string): PrintConfig =>
  mergeConfigs(loadProfile('demo', 'Demo Printer 0.4 nozzle').config, loadProfile('demo', filament).config, loadProfile('demo', '0.20mm Standard @Demo').config)

const baseConfig = merged('Demo PLA')
const configs: Record<string, PrintConfig> = {
  base: baseConfig,
  petg: merged('Demo PETG'),
  smart: { ...baseConfig, smart_layer: 'quality', smart_layer_min_height: 0.1, smart_layer_max_height: 0.3, smart_layer_smoothing: 50, smart_layer_max_step_ratio: 0.25 } as PrintConfig,
  thin: { ...baseConfig, smart_layer: 'quality', smart_layer_min_height: 0.08, smart_layer_max_height: 0.2, slow_down_layer_time: [2], slow_down_min_speed: [10], enable_support: true } as PrintConfig,
  creep: { ...baseConfig, layer_height: 0.08, slow_down_for_layer_cooling: [true], slow_down_min_speed: [10] } as PrintConfig,
}
const cases = (read('plan-cases.json') as { cases: Case[] }).cases

/** FNV-1a over the UTF-8 bytes, 8 hex digits. The Rust test uses the same function. */
function fnv(text: string): string {
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(text)) h = Math.imul(h ^ b, 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

interface Obj { [k: string]: unknown }
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : [])

/**
 * The plan as the golden file stores it: everything a test needs to compare, with the long texts
 * (reasons, sources, advice) reduced to hashes so the file stays small. Same recipe in tests/parity.rs.
 */
function plain(plan: unknown): unknown {
  const o = JSON.parse(JSON.stringify(plan)) as Obj
  const strs = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [])
  return {
    from: o['from'],
    to: o['to'],
    changes: arr(o['changes']).map((c) => ({
      key: c['key'],
      before: c['before'],
      after: c['after'],
      origin: c['origin'],
      klass: c['klass'],
      approval: c['approval'],
      ...(c['goal'] !== undefined ? { goal: c['goal'] } : {}),
      ...(c['priority'] !== undefined ? { priority: c['priority'] } : {}),
      t: fnv([c['label'], c['section'], c['unit'] ?? '', c['reason'], ...strs(c['sources'])].join('\u0001')),
    })),
    unresolved: arr(o['unresolved']).map((u) => ({ key: u['key'], t: fnv(String(u['reason'])) })),
    warnings: o['warnings'],
    clamps: arr(o['clamps']).map((c) => ({ key: c['key'], requested: c['requested'], applied: c['applied'], by: c['by'], limit: c['limit'], t: fnv(String(c['reason'])) })),
    refused: arr(o['refused']).map((r) => ({ key: r['key'], requested: r['requested'], t: fnv(String(r['reason'])) })),
    blockers: o['blockers'],
    questions: o['questions'],
    caveats: arr(o['caveats']).map((c) => ({ t: fnv([c['text'], ...strs(c['sources'])].join('\u0001')) })),
    advice: arr(o['advice']).map((a) => ({ kind: a['kind'], t: fnv([a['text'], ...strs(a['sources'])].join('\u0001')) })),
    tellUser: o['tellUser'],
  }
}

function run(c: Case): unknown {
  const o = c.options
  return plain(
    planSettings(c.from, c.to, c.base ? configs[c.base === true ? 'base' : c.base] : undefined, {
      ...(o.intent ? { intent: o.intent } : {}),
      ...(o.calibrations ? { calibrations: o.calibrations } : {}),
      ...(o.keep ? { keep: new Set(o.keep) } : {}),
      ...(o.tuned ? { tuned: new Set(o.tuned) } : {}),
      ...(o.target ? { target: configs[o.target] as PrintConfig } : {}),
    }),
  )
}

const validateCases = (read('validate-cases.json') as { cases: { name: string; config: PrintConfig }[] }).cases

describe('golden files', () => {
  if (update) {
    it('rewrites the golden files', () => {
      writeFileSync(dir + 'plan-configs.json', JSON.stringify({ comment: 'Merged demo setups for plan-cases.json: the current plate (base), a PETG target, the plate with sleipnir on, thin layers with supports, and a thin fixed layer height.', ...configs }, null, 1) + '\n')
      const lines = cases.map((c) => `  ${JSON.stringify(c.name)}: ${JSON.stringify(run(c))}`)
      const head = JSON.stringify('Written by js/plan.parity.test.ts (UPDATE_GOLDEN=1). Both implementations must produce these plans. Reasons, sources and advice are stored as FNV-1a hashes (t) of their text.')
      writeFileSync(dir + 'plan-golden.json', `{\n "comment": ${head},\n "plans": {\n${lines.join(',\n')}\n }\n}\n`)
      const vg: Record<string, unknown> = {}
      for (const c of validateCases) vg[c.name] = JSON.parse(JSON.stringify(validate(c.config)))
      writeFileSync(dir + 'validate-golden.json', JSON.stringify({ comment: 'Full validate output for validate-cases.json. Both implementations must produce these issues.', issues: vg }, null, 1) + '\n')
    })
    return
  }

  it('keeps the merged setups the cases use', () => {
    const file = read('plan-configs.json') as Record<string, unknown>
    expect(file['base']).toEqual(JSON.parse(JSON.stringify(configs['base'])))
    expect(file['petg']).toEqual(JSON.parse(JSON.stringify(configs['petg'])))
    expect(file['smart']).toEqual(JSON.parse(JSON.stringify(configs['smart'])))
    expect(file['thin']).toEqual(JSON.parse(JSON.stringify(configs['thin'])))
    expect(file['creep']).toEqual(JSON.parse(JSON.stringify(configs['creep'])))
  })

  const golden = (read('plan-golden.json') as { plans: Record<string, unknown> }).plans
  it('has a plan for every case', () => {
    expect(Object.keys(golden).sort()).toEqual(cases.map((c) => c.name).sort())
    expect(cases.length).toBeGreaterThanOrEqual(32)
  })
  for (const c of cases) {
    it(`plans: ${c.name}`, () => {
      expect(run(c)).toEqual(golden[c.name])
    })
  }

  const vg = (read('validate-golden.json') as { issues: Record<string, unknown> }).issues
  for (const c of validateCases) {
    it(`validates: ${c.name}`, () => {
      expect(JSON.parse(JSON.stringify(validate(c.config)))).toEqual(vg[c.name])
    })
  }
})
