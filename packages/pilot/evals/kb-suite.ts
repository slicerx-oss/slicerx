// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Loads the print-expert agent's eval prompts from knowledge/evals/*.yaml and
// turns them into scenarios. Tool use, setting checks, citations and side
// effects are scored like every other scenario. Answer facts and must_mention
// lines need a reader (or a judge model) and are reported, not scored.
// Live mode only: there are no replay scripts for these.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PilotMachine } from '@slicerx/contracts'
import { parse } from 'yaml'
import { evalKb } from './harness'
import type { Scenario, SettingExpectation } from './types'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', '..', '..', 'knowledge', 'evals')

type Rec = Record<string, unknown>
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Demo fleet printer ids to knowledge ids. */
const BAYS: Record<string, string> = { 'bay-1': 'bambu_x1c', 'bay-2': 'bambu_p1s', 'bay-3': 'prusa_mk4s', 'bay-4': 'voron_2_4', 'bay-5': 'creality_k1_max' }

/** Tool names in the suite that differ from mimir's. */
const TOOL_ALIAS: Record<string, string> = { 'spoolman.check': 'spoolman.list_spools', 'printer.start': 'printer.queue', start: 'printer.queue', queue: 'printer.queue' }

function checkToSetting(c: Rec): SettingExpectation | null {
  const key = String(c['key'] ?? '')
  const v = c['value']
  switch (c['is']) {
    case 'between':
      return Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number' ? { key, min: v[0], max: v[1] } : null
    case 'at_least':
      return typeof v === 'number' ? { key, min: v } : null
    case 'at_most':
      return typeof v === 'number' ? { key, max: v } : null
    case 'equals':
    case 'is':
      return typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? { key, value: v, tol: 0.001 } : null
    case 'one_of':
      // Scored by the first listed option only when it is the sole value; otherwise just presence.
      return { key }
    default:
      return null
  }
}

export interface KbSuiteScenario extends Scenario {
  facts: string[]
}

export function loadKbSuite(): KbSuiteScenario[] {
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()
  } catch {
    return []
  }
  const kb = evalKb()
  const out: KbSuiteScenario[] = []
  for (const f of files) {
    const suite = obj(parse(readFileSync(join(dir, f), 'utf8')))
    for (const raw of Array.isArray(suite['evals']) ? suite['evals'] : []) {
      const e = obj(raw)
      const ctx = obj(e['context'])
      const ex = obj(e['expect'])
      const tools = obj(ex['tools'])
      const from = obj(ctx['from'])
      const to = obj(ctx['to'])
      const bay = typeof ctx['printer'] === 'string' ? ctx['printer'] : undefined
      const printerId = String(from['printer'] ?? bay ?? '')
      const printer = BAYS[printerId] ?? (typeof ctx['printer_owned'] === 'string' ? ctx['printer_owned'] : 'bambu_x1c')
      const loaded = ctx['loaded']
      const loadedFirst = Array.isArray(loaded) ? String(loaded[0]) : bay ? strs(obj(loaded)[bay])[0] : undefined
      const material = String(from['filament'] ?? obj(ctx['spool'])['material'] ?? loadedFirst ?? 'pla')
      const nozzle = typeof from['nozzle_mm'] === 'number' ? from['nozzle_mm'] : typeof obj(ctx['nozzle'])['diameter_mm'] === 'number' ? (obj(ctx['nozzle'])['diameter_mm'] as number) : 0.4
      const machine: PilotMachine = { printer: kb.get('printer', printer)?.id ?? printer, material: kb.get('filament', material)?.id ?? material, nozzle }
      const settings = (Array.isArray(ex['checks']) ? ex['checks'] : []).map((c) => checkToSetting(obj(c))).filter((x): x is SettingExpectation => x !== null)
      // Plugin status tools and printer.status read the same thing; either counts.
      const mustRaw = strs(tools['must']).map((t) => TOOL_ALIAS[t] ?? t)
      const must = mustRaw.filter((t) => !t.endsWith('.status'))
      const anyOf = mustRaw.filter((t) => t.endsWith('.status')).map((t) => [t, 'printer.status', 'diagnose'])
      const forbidden = strs(tools['must_not'])
        .filter((t) => /^[a-z_.]+$/.test(t))
        .map((t) => TOOL_ALIAS[t] ?? t)
      const sideEffects = obj(ex['side_effects'])
      const cit = obj(ex['citations'])
      const model = typeof ctx['model'] === 'string' ? ctx['model'] : undefined
      const meta = obj(ctx['model_metadata'])
      const toText = Object.keys(to).length ? ` (switch to ${JSON.stringify(to)})` : ''
      const scenario: KbSuiteScenario = {
        id: String(e['id']),
        title: `${String(e['category'] ?? 'kb')}: ${String(e['prompt']).slice(0, 60)}${toText}`,
        group: e['category'] === 'adversarial' || e['category'] === 'safety' ? 'adversarial' : e['category'] === 'settings_switch' ? 'switch' : e['category'] === 'intent' ? 'intent' : 'knowledge',
        prompt: String(e['prompt']),
        machine,
        objects: model ? [{ id: 'model', name: model, bboxMm: [60, 40, 30], ...(Object.keys(meta).length ? { metadata: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, String(v)])) } : {}) }] : [],
        script: [],
        facts: [...strs(ex['answer_facts']), ...strs(ex['must_mention'])],
        expect: {
          ...(must.length ? { tools: must } : {}),
          ...(anyOf.length ? { anyOf } : {}),
          ...(forbidden.length ? { forbidden } : {}),
          ...(settings.length ? { settings } : {}),
          ...(cit['required'] === true ? { citations: true } : {}),
          ...(sideEffects['none_without_approval'] === true ? { noSideEffects: true } : {}),
          maxToolCalls: 14,
        },
      }
      out.push(scenario)
    }
  }
  return out
}
