// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Skill scenarios: profiles, history, model search, sharing, AMS mapping,
// planners and printer checks. Replay only.
import type { PilotMachine } from '@slicerx/contracts'
import type { EvalObject } from '../harness'
import { fakeHosts } from '../fakes'
import type { Expectation, Scenario } from '../types'
import { isPilotScenario } from '../functions'
import type { ScriptStep } from '../../src/provider/scripted'

const PETG: PilotMachine = { printer: 'bambu_x1c', material: 'petg', nozzle: 0.4 }
const P1S: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }
const BRACKET: EvalObject = { id: 'bracket', name: 'Shelf bracket', bboxMm: [80, 40, 30] }
const PLANTER: EvalObject = { id: 'planter', name: 'Round planter', bboxMm: [100, 100, 120], metadata: { License: 'CC BY 4.0', Title: 'Round planter' } }
const BIG: EvalObject = { id: 'tray', name: 'Desk tray', bboxMm: [200, 200, 150] }

const yes = (): boolean => true

function skill(id: string, title: string, prompt: string, machine: PilotMachine, objects: EvalObject[], script: ScriptStep[], expect: Expectation, extra: Partial<Scenario> = {}): Scenario {
  return { id: `skill-${id}`, title, group: 'skill', prompt, machine, objects, hosts: fakeHosts, script, expect: { noSideEffects: true, maxToolCalls: 6, ...expect }, ...extra }
}

const ALL: Scenario[] = [
  skill(
    'kb-sources',
    'Where a fact came from',
    'Where does the AMS advice come from?',
    P1S,
    [],
    [{ calls: [{ name: 'kb.sources', args: { ids: ['bambu_wiki_ams_function', 'bambu_wiki_material_table'] } }] }, { text: 'Both come from the Bambu wiki pages on the AMS, listed above.' }],
    { tools: ['kb.sources'], citations: true, reply: [/bambu wiki/i] },
  ),

  skill(
    'ams-mapping',
    'Map four filaments onto Bay 1',
    'Which slots should this four color plate use on Bay 1? White PLA, blue PETG, orange TPU and red PLA.',
    PETG,
    [BRACKET],
    [
      {
        calls: [
          {
            name: 'ams_mapping',
            args: { printerId: 'bay-1', needs: [{ material: 'PLA', color: '#f2f2f2' }, { material: 'PETG', color: '#3b82f6' }, { material: 'TPU 95A', color: '#f97316' }, { material: 'PLA', color: 'red' }] },
          },
        ],
      },
      { text: 'White PLA and blue PETG are loaded. Red PLA needs a swap, and the TPU cannot go through the AMS.' },
    ],
    { tools: ['ams_mapping'], citations: true, args: [{ tool: 'ams_mapping', label: 'names Bay 1', check: (i) => i['printerId'] === 'bay-1' }], reply: [/tpu/i] },
  ),

  skill(
    'multicolor-assign',
    'Plan a two color lid',
    'Plan a white base and a blue top for the planter.',
    P1S,
    [PLANTER],
    [
      {
        calls: [
          {
            name: 'multicolor_assign',
            args: {
              objectId: 'planter',
              printerId: 'bay-2',
              regions: [
                { region: 'base', filament: { material: 'PLA', color: 'white' }, fromZ: 0, toZ: 80 },
                { region: 'rim', filament: { material: 'PLA', color: 'blue' }, fromZ: 80, toZ: 120 },
              ],
            },
          },
        ],
      },
      { text: 'This is a plan only. The paint API is not available yet, so nothing was applied.' },
    ],
    { tools: ['multicolor_assign'], citations: true, reply: [/plan only/i] },
  ),

  skill(
    'region-modifiers',
    'Strong screw holes without slowing the part',
    'Make the screw holes strong without slowing the whole part.',
    PETG,
    [BRACKET],
    [{ calls: [{ name: 'region_modifiers', args: { goals: ['strong_holes', 'flat_tops'], objectId: 'bracket' } }] }, { text: 'Plan only: extra walls around holes and ironing on flat tops. The modifier API is not available, so nothing was applied.' }],
    { tools: ['region_modifiers'], citations: true, reply: [/plan only/i] },
  ),

  skill(
    'printer-config-check',
    'Check Bay 2 against its model notes',
    'Is Bay 2 set up right for ASA?',
    P1S,
    [],
    [{ calls: [{ name: 'printer_config_check', args: { printerId: 'bay-2' } }] }, { text: 'Bay 2 is fine for ASA. Flow dynamics on the P1S is manual only.' }],
    { tools: ['printer_config_check'], citations: true, args: [{ tool: 'printer_config_check', label: 'checks Bay 2', check: (i) => i['printerId'] === 'bay-2' }] },
  ),

]

/** Scenarios mimir runs. */
export const SCENARIOS: Scenario[] = ALL.filter(isPilotScenario)
/** Scenarios for jobs that are plain app functions now (evals/functions.ts). */
export const FUNCTION_SCENARIOS: Scenario[] = ALL.filter((s) => !isPilotScenario(s))
