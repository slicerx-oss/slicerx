// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Skill scenarios: printers, scheduling, inventory and business.
import type { HistoryHost, JobRecord } from '../../src/hosts'
import type { Scenario } from '../types'
import { isPilotScenario } from '../functions'

/** A small print log for the maintenance scenario. */
const LOG: JobRecord[] = [
  { id: 'j1', printerId: 'bay-1', material: 'PA-CF', model: 'Gear housing', startedAt: '2026-09-02T08:00:00Z', finishedAt: '2026-09-02T20:00:00Z', outcome: 'success', grams: 420, seconds: 43200 },
  { id: 'j2', printerId: 'bay-1', material: 'PA-CF', model: 'Bracket', startedAt: '2026-09-10T08:00:00Z', finishedAt: '2026-09-10T14:00:00Z', outcome: 'success', grams: 160, seconds: 21600 },
  { id: 'j3', printerId: 'bay-1', material: 'PLA', model: 'Cable hook', startedAt: '2026-09-15T08:00:00Z', finishedAt: '2026-09-15T10:00:00Z', outcome: 'success', grams: 40, seconds: 7200 },
  { id: 'j4', printerId: 'bay-2', material: 'ASA', model: 'Enclosure lid', startedAt: '2026-09-12T08:00:00Z', finishedAt: '2026-09-12T18:00:00Z', outcome: 'success', grams: 210, seconds: 36000 },
]

const historyFake: HistoryHost = {
  async query(q) {
    return LOG.filter((j) => (!q.printerId || j.printerId === q.printerId) && (!q.since || j.startedAt >= q.since))
  },
}

const P1S = { printer: 'bambu_p1s', material: 'asa', nozzle: 0.4 }
const hasArg = (k: string, re: RegExp) => (i: Record<string, unknown>) => re.test(String(i[k]))

const ALL: Scenario[] = [
  {
    id: 'skill-printer-match',
    title: 'Pick a printer for an ASA part',
    group: 'skill',
    prompt: 'Which printer should I use for this ASA enclosure lid?',
    machine: { printer: 'bambu_p1s', material: 'asa', nozzle: 0.4 },
    objects: [{ id: 'lid', name: 'Enclosure lid', bboxMm: [180, 140, 20] }],
    script: [
      { calls: [{ name: 'printer_match', args: { material: 'ASA', objectId: 'lid' } }] },
      { text: 'Bay 2 (P1S) is free with ASA loaded and enclosed, so use it.' },
    ],
    expect: {
      tools: ['printer_match'],
      args: [{ tool: 'printer_match', label: 'asks for ASA', check: (i) => /asa/i.test(String(i['material'])) }],
      citations: true,
      noSideEffects: true,
      reply: [/bay 2/i],
      maxToolCalls: 4,
    },
  },
  {
    id: 'skill-fleet-overview',
    title: 'What is every printer doing',
    group: 'skill',
    prompt: 'What is every printer doing right now?',
    machine: P1S,
    objects: [],
    script: [
      { calls: [{ name: 'fleet_overview', args: {} }] },
      { text: 'Bay 1 is printing. Bay 3 is paused and asking for a filament change, Bay 4 finished with the part still on the bed, Bay 5 is offline, and the TPU on Bay 1 is nearly gone.' },
    ],
    expect: {
      tools: ['fleet_overview'],
      noSideEffects: true,
      reply: [/paused/i, /offline/i],
      maxToolCalls: 2,
    },
  },
  {
    id: 'skill-fleet-overview-fleet',
    title: 'Status of the Workshop group only',
    group: 'skill',
    prompt: 'Anything wrong in the Workshop group?',
    machine: P1S,
    objects: [],
    script: [
      { calls: [{ name: 'fleet_overview', args: { fleet: 'Workshop' } }] },
      { text: 'In the Workshop group, Bay 3 is paused and Bay 1 has a spool of TPU running low.' },
    ],
    expect: {
      tools: ['fleet_overview'],
      args: [{ tool: 'fleet_overview', label: 'uses the Workshop fleet', check: hasArg('fleet', /workshop/i) }],
      noSideEffects: true,
      reply: [/bay 3/i],
      maxToolCalls: 2,
    },
  },
  {
    id: 'skill-material-recommend',
    title: 'Material for a dashboard mount in the sun',
    group: 'skill',
    prompt: 'What should I print a phone mount for my car dashboard in? It sits in the summer sun.',
    machine: { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 },
    objects: [{ id: 'mount', name: 'Phone mount', bboxMm: [80, 60, 40] }],
    script: [
      { calls: [{ name: 'material_recommend', args: { needs: ['heat', 'uv'], useTemperatureC: 80, useCase: 'dashboard phone mount in summer sun' } }] },
      { text: 'ASA is the pick: it softens well above 80 C and holds up in sunlight. You have a spool loaded in Bay 2, and the P1S is enclosed.' },
    ],
    expect: {
      tools: ['material_recommend'],
      args: [{ tool: 'material_recommend', label: 'gives the 80 C use temperature', check: (i) => i['useTemperatureC'] === 80 }],
      citations: true,
      noSideEffects: true,
      reply: [/asa/i],
      maxToolCalls: 3,
    },
  },
  {
    id: 'skill-schedule',
    title: 'Plan two orders by due date',
    group: 'skill',
    prompt: 'I need 24 cable hooks in PLA by Friday and 12 brackets in ASA by Thursday. Plan it on the cheapest printers.',
    machine: { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 },
    objects: [
      { id: 'hook', name: 'Cable hook', bboxMm: [40, 25, 20] },
      { id: 'bracket', name: 'Bracket', bboxMm: [60, 40, 25] },
    ],
    script: [
      {
        calls: [
          {
            name: 'schedule',
            args: {
              jobs: [
                { objectId: 'hook', copies: 24, material: 'PLA', dueDate: '2026-10-02' },
                { objectId: 'bracket', copies: 12, material: 'ASA', dueDate: '2026-10-01' },
              ],
            },
          },
        ],
      },
      { text: 'Both orders fit the deadlines. Nothing is queued yet. Say the word and I will arrange, slice and queue each plate for your approval.' },
    ],
    expect: {
      tools: ['schedule'],
      args: [{ tool: 'schedule', label: 'plans both jobs', check: (i) => Array.isArray(i['jobs']) && i['jobs'].length === 2 }],
      forbidden: ['printer.queue'],
      citations: true,
      noSideEffects: true,
      reply: [/nothing is queued/i],
      maxToolCalls: 3,
    },
  },
  {
    id: 'skill-spool-inventory',
    title: 'Enough black PLA for the week',
    group: 'skill',
    prompt: 'Do I have enough black PLA for 700 g of cable hooks this week?',
    machine: { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 },
    objects: [{ id: 'hook', name: 'Cable hook', bboxMm: [40, 25, 20] }],
    script: [
      { calls: [{ name: 'spool_inventory', args: { needs: [{ material: 'PLA', color: 'black', grams: 700, label: 'cable hooks' }] } }] },
      { text: 'Not quite: the black PLA spool has 640 g, so you are 60 g short. One more spool covers it. Nothing was ordered.' },
    ],
    expect: {
      tools: ['spool_inventory'],
      args: [{ tool: 'spool_inventory', label: 'asks about black PLA', check: (i) => JSON.stringify(i['needs']).toLowerCase().includes('black') }],
      forbidden: ['store.order'],
      noSideEffects: true,
      reply: [/short/i],
      maxToolCalls: 2,
    },
  },
  {
    id: 'skill-spool-fit',
    title: 'Will the TPU spool finish a gasket',
    group: 'skill',
    prompt: 'Will the TPU spool on Bay 1 finish a gasket that needs 80 g?',
    machine: P1S,
    objects: [{ id: 'gasket', name: 'Gasket', bboxMm: [90, 90, 6] }],
    script: [
      { calls: [{ name: 'spool_fit', args: { printerId: 'bay-1', slot: 'A4', gramsNeeded: 80 } }] },
      { text: 'No. Slot A4 has about 60 g of TPU, so the gasket is short. Load a fuller spool before you start.' },
    ],
    expect: {
      tools: ['spool_fit'],
      args: [{ tool: 'spool_fit', label: 'checks Bay 1 slot A4', check: (i) => i['printerId'] === 'bay-1' && i['slot'] === 'A4' }],
      noSideEffects: true,
      reply: [/60 g/i],
      maxToolCalls: 2,
    },
  },
  {
    id: 'skill-overnight-readiness',
    title: 'Overnight ASA print on Bay 2',
    group: 'skill',
    prompt: 'Is Bay 2 safe to run this 14 hour ASA enclosure lid overnight? It needs about 180 g.',
    machine: P1S,
    objects: [{ id: 'lid', name: 'Enclosure lid', bboxMm: [180, 140, 20] }],
    script: [
      { calls: [{ name: 'overnight_readiness', args: { printerId: 'bay-2', material: 'ASA', hours: 14, gramsNeeded: 180 } }] },
      { text: 'Bay 2 passes the main checks: it is idle, has enough ASA, and is enclosed. The warnings are fumes and the lack of spaghetti detection, so run it in a ventilated room.' },
    ],
    expect: {
      tools: ['overnight_readiness'],
      args: [{ tool: 'overnight_readiness', label: 'checks Bay 2', check: hasArg('printerId', /^bay-2$/) }],
      citations: true,
      noSideEffects: true,
      reply: [/ventilated/i],
      maxToolCalls: 2,
    },
  },
  {
    id: 'skill-energy-estimate',
    title: 'Electricity for a 14 hour ASA print',
    group: 'skill',
    prompt: 'How much electricity does a 14 hour ASA print on Bay 2 use? Power costs 18 cents per kWh.',
    machine: P1S,
    objects: [],
    script: [
      { calls: [{ name: 'energy_estimate', args: { printer: 'bay-2', hours: 14, material: 'ASA', pricePerKwh: 0.18 } }] },
      { text: 'About 2 kWh, roughly 36 cents. The wattage comes from the printer knowledge, and the heat-up time is an assumption.' },
    ],
    expect: {
      tools: ['energy_estimate'],
      args: [{ tool: 'energy_estimate', label: 'uses 14 hours and 0.18', check: (i) => i['hours'] === 14 && i['pricePerKwh'] === 0.18 }],
      citations: true,
      noSideEffects: true,
      reply: [/kWh/i],
      maxToolCalls: 2,
    },
  },
]

/** Scenarios mimir runs. */
export const SCENARIOS: Scenario[] = ALL.filter(isPilotScenario)
/** Scenarios for jobs that are plain app functions now (evals/functions.ts). */
export const FUNCTION_SCENARIOS: Scenario[] = ALL.filter((s) => !isPilotScenario(s))
