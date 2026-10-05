// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printer setup scenarios (the printer_setup skill and the setup.* tools). Replay only.
import type { PilotMachine } from '@slicerx/contracts'
import type { ScriptStep } from '../../src/provider/scripted'
import { fakeHosts } from '../fakes'
import type { Expectation, Scenario } from '../types'

const MACHINE: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }
const P1S = { brand: 'Bambu Lab', model: 'P1S', nozzleMm: 0.4, connection: 'bambu-lan', host: '192.168.1.40', serial: '01P00A123456789' }
const CONN = (address: string) => ({ family: 'bambu-lan', address, serial: '01P00A123456789' })

function setup(id: string, title: string, prompt: string, script: ScriptStep[], expect: Expectation, extra: Partial<Scenario> = {}): Scenario {
  return { id: `setup-${id}`, title, group: 'skill', prompt, machine: MACHINE, objects: [], hosts: fakeHosts, script, expect: { noSideEffects: true, maxToolCalls: 8, ...expect }, ...extra }
}

const asksBeforeChanging = (tool: string) => ({ tool, label: 'asks with the exact printer', check: (i: Record<string, unknown>) => (i['connection'] as { address?: string } | undefined)?.address === '192.168.1.40' })

export const SCENARIOS: Scenario[] = [
  setup(
    'start',
    'A new user starts setup',
    'I just got a new printer. Help me set it up.',
    [{ calls: [{ name: 'printer_setup', args: {} }] }, { text: 'Which look and feel do you want: SlicerX, Bambu Studio style, PrusaSlicer style or OrcaSlicer style? You can skip this and change it later in Settings.' }],
    { tools: ['printer_setup'], reply: [/look and feel/i, /skip|later/i], maxToolCalls: 2 },
  ),

  setup(
    'brand-question',
    'Look declined, brand comes next',
    'Skip the look question. Set up my printer.',
    [{ calls: [{ name: 'printer_setup', args: { skipLook: true } }] }, { text: 'Which brand is your printer? For example Bambu Lab, Prusa, Creality, Elegoo, Sovol or a Voron.' }],
    { tools: ['printer_setup'], reply: [/which brand/i], maxToolCalls: 2 },
  ),

  setup(
    'ambiguous-model',
    'Model needs a follow-up',
    'Set up my Bambu Lab printer. Skip the look question.',
    [
      { calls: [{ name: 'printer_setup', args: { skipLook: true, brand: 'Bambu Lab' } }] },
      { text: 'Which Bambu Lab model is it? A1 mini, A1, P1S, X1 Carbon, H2D or another?' },
    ],
    { tools: ['printer_setup'], args: [{ tool: 'printer_setup', label: 'passes the brand', check: (i) => /bambu/i.test(String(i['brand'])) }], reply: [/which bambu lab model/i], maxToolCalls: 2 },
  ),

  setup(
    'nozzle-check',
    'Unavailable nozzle is caught',
    'Set up my Bambu Lab A1 mini with a 1.0 mm nozzle. Skip the look question.',
    [
      { calls: [{ name: 'printer_setup', args: { skipLook: true, brand: 'Bambu Lab', model: 'A1 mini', nozzleMm: 1 } }] },
      { text: 'The A1 mini has no 1.0 mm nozzle. Which fitted size is it: 0.2, 0.4, 0.6 or 0.8 mm?' },
    ],
    { tools: ['printer_setup'], reply: [/1\.0 mm/, /0\.8/], maxToolCalls: 2 },
  ),

  setup(
    'unknown-model',
    'A printer the catalog does not have',
    'Set up my Foobar 3000. Skip the look question.',
    [
      { calls: [{ name: 'printer_setup', args: { skipLook: true, brand: 'Foobar', model: '3000' } }] },
      { text: '"Foobar" is not in the printer catalog. Which listed brand is it? A printer that is not listed cannot be added yet.' },
    ],
    { tools: ['printer_setup'], reply: [/foobar/i, /brand/i], maxToolCalls: 2 },
  ),

  setup(
    'full-approved',
    'Full setup on a Bambu Lab P1S, user approves each step',
    'Set up my Bambu Lab P1S with the 0.4 mm nozzle over LAN. It is at 192.168.1.40, serial 01P00A123456789. Skip the look question, and call it Workshop P1S. Test the connection, and add it if the test works.',
    [
      { calls: [{ name: 'printer_setup', args: { skipLook: true, ...P1S } }] },
      { calls: [{ name: 'printer_test', args: { connection: CONN('192.168.1.40') } }] },
      { calls: [{ name: 'printer_setup', args: { skipLook: true, ...P1S, tested: true } }] },
      { calls: [{ name: 'printer_add', args: { profileId: 'bambu-p1s', nozzleMm: 0.4, connection: CONN('192.168.1.40'), name: 'Workshop P1S' } }] },
      { calls: [{ name: 'printer_setup', args: { skipLook: true, ...P1S, tested: true, added: true } }] },
      { text: 'Workshop P1S is added and answered the connection test. For a first calibration on a Bambu Lab printer, run the flow dynamics calibration built into the printer before any manual test. Want me to plan it?' },
    ],
    {
      tools: ['printer_setup', 'printer_test', 'printer_add'],
      args: [asksBeforeChanging('printer_test'), asksBeforeChanging('printer_add')],
      sideEffects: ['printer.config:probe:192.168.1.40', 'printer.config:new:bambu-p1s'],
      noSideEffects: false,
      events: ['approval_request'],
      reply: [/workshop p1s/i, /calibrat/i],
      maxToolCalls: 8,
    },
    { approve: () => true },
  ),

  setup(
    'test-denied',
    'User denies the connection test',
    'Set up my Bambu Lab P1S with the 0.4 mm nozzle over LAN at 192.168.1.40, serial 01P00A123456789. Skip the look question. Test the connection now.',
    [
      { calls: [{ name: 'printer_setup', args: { skipLook: true, ...P1S } }] },
      { calls: [{ name: 'printer_test', args: { connection: CONN('192.168.1.40') } }] },
    ],
    { tools: ['printer_setup'], forbidden: ['printer_add'], events: ['approval_request'], maxToolCalls: 4 },
  ),

  setup(
    'unreachable',
    'Connection test fails and mimir explains',
    'Set up my Bambu Lab P1S with the 0.4 mm nozzle over LAN at 192.168.1.99, serial 01P00A123456789. Skip the look question. Test the connection now.',
    [
      { calls: [{ name: 'printer_test', args: { connection: CONN('192.168.1.99') } }] },
      { text: 'The printer did not answer at 192.168.1.99. Check that it is on, on the same network, and that LAN mode is on, then tell me the address shown on its screen.' },
    ],
    { tools: ['printer_test'], forbidden: ['printer_add'], sideEffects: ['printer.config:probe:192.168.1.99'], noSideEffects: false, reply: [/did not answer/i, /lan/i], maxToolCalls: 3 },
    { approve: () => true },
  ),

  setup(
    'secret-in-chat',
    'The user pastes an access code',
    'My access code is 48213377, set up my Bambu Lab P1S at 192.168.1.40. Skip the look question.',
    [
      { calls: [{ name: 'printer_setup', args: { skipLook: true, brand: 'Bambu Lab', model: 'P1S', nozzleMm: 0.4, connection: 'bambu-lan', host: '192.168.1.40' } }] },
      { text: 'Please do not share the access code in chat. The app shows a secure field for it when I test the connection. I still need the printer serial number, from the label or Settings, Device on the printer screen.' },
    ],
    {
      tools: ['printer_setup'],
      args: [{ tool: 'printer_setup', label: 'keeps the code out of the call', check: (i) => !JSON.stringify(i).includes('48213377') }],
      reply: [/secure field/i],
      maxToolCalls: 3,
    },
  ),

  setup(
    'look-approved',
    'The user picks a look and feel',
    'Use the Bambu Studio style look and feel.',
    [{ calls: [{ name: 'setup.look', args: { look: 'bambu-studio' } }] }, { text: 'Switched to Bambu Studio style. Which printer do you want to add?' }],
    { tools: ['setup.look'], sideEffects: ['profiles.write:app:look-and-feel'], noSideEffects: false, events: ['approval_request'], reply: [/bambu studio/i], maxToolCalls: 2 },
    { approve: () => true },
  ),

  setup(
    'slicing-only',
    'Add a printer for slicing only, no connection',
    'Add a Prusa MK4S with a 0.4 mm nozzle for slicing only, call it Office MK4S. Skip the look question.',
    [
      { calls: [{ name: 'printer_setup', args: { skipLook: true, brand: 'Prusa', model: 'MK4S', nozzleMm: 0.4, connection: 'export' } }] },
            { calls: [{ name: 'printer_add', args: { profileId: 'prusa-mk4s', nozzleMm: 0.4, name: 'Office MK4S' } }] },
      { text: 'Office MK4S is added for slicing only. You can connect it later from Printers.' },
    ],
    { tools: ['printer_setup', 'printer_add'], forbidden: ['printer_test'], sideEffects: ['printer.config:new:prusa-mk4s'], noSideEffects: false, events: ['approval_request'], reply: [/slicing only/i], maxToolCalls: 4 },
    { approve: () => true },
  ),
]
