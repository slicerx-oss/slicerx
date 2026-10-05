// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// check_print scenarios: "how's the print going?" with stored camera frames
// (evals/frames). Replay only. Bay 1 of the demo fleet is printing and has a
// camera; Bay 3 is paused and has none.
import type { PilotMachine } from '@slicerx/contracts'
import { ASSISTANT_NAME } from '../../src/name'
import { FRAMES } from '../frames/index'
import type { Scenario } from '../types'

const X1C: PilotMachine = { printer: 'bambu_x1c', material: 'pla', nozzle: 0.4 }

const change = (i: Record<string, unknown>): Record<string, unknown> => (i['change'] && typeof i['change'] === 'object' ? (i['change'] as Record<string, unknown>) : {})

export const SCENARIOS: Scenario[] = [
  {
    id: 'check-print-peeling',
    title: 'A corner lifting: lower the fan, approved',
    group: 'skill',
    prompt: `Hey ${ASSISTANT_NAME}, how's the print going?`,
    machine: X1C,
    objects: [],
    frames: { 'bay-1': FRAMES['corner-lifting'] },
    approve: (req) => req.tool === 'print.adjust',
    script: [
      { calls: [{ name: 'check_print', args: {} }] },
      {
        text: "It's going, but the bottom left corner is starting to lift off the plate. Less part cooling usually lets it settle back. ",
        calls: [{ name: 'print.adjust', args: { printerId: 'bay-1', change: { kind: 'part_fan', percent: 40 }, reason: 'The bottom left corner is starting to lift from the plate' } }],
      },
      { text: 'Done: the part fan on Bay 1 is at 40 %. I will check the corner again in a few layers if you ask.' },
    ],
    expect: {
      tools: ['check_print', 'print.adjust'],
      imagesToModel: 1,
      sideEffects: ['callTool:bambu-lan'],
      args: [{ tool: 'print.adjust', label: 'lowers the part fan', check: (i) => change(i)['kind'] === 'part_fan' && Number(change(i)['percent']) < 100 }],
      reply: [/lift/i, /fan/i],
      maxToolCalls: 3,
    },
  },
  {
    id: 'check-print-peeling-declined',
    title: 'A corner lifting: the user declines the fan change',
    group: 'skill',
    prompt: "How's Bay 1 doing?",
    machine: X1C,
    objects: [],
    frames: { 'bay-1': FRAMES['corner-lifting'] },
    approve: () => false,
    script: [
      { calls: [{ name: 'check_print', args: { printerId: 'bay-1' } }] },
      {
        text: 'The bottom left corner is starting to lift. ',
        calls: [{ name: 'print.adjust', args: { printerId: 'bay-1', change: { kind: 'part_fan', percent: 40 }, reason: 'The bottom left corner is starting to lift' } }],
      },
    ],
    // A declined card ends the run; the call shows as the card, not as a tool call.
    expect: { tools: ['check_print'], imagesToModel: 1, noSideEffects: true, events: ['approval_request'], maxToolCalls: 3 },
  },
  {
    id: 'check-print-spaghetti',
    title: 'Spaghetti: pause, approved',
    group: 'skill',
    prompt: "How's the print going?",
    machine: X1C,
    objects: [],
    frames: { 'bay-1': FRAMES['spaghetti'] },
    approve: (req) => req.tool === 'print.adjust',
    script: [
      { calls: [{ name: 'check_print', args: {} }] },
      {
        text: 'This has failed: there is a tangle of loose filament around the nozzle above a short base. I suggest pausing now. ',
        calls: [{ name: 'print.adjust', args: { printerId: 'bay-1', change: { kind: 'pause' }, reason: 'Loose filament around the nozzle: the print has failed' } }],
      },
      { text: 'Bay 1 is paused. Clear the plate before you cancel or restart.' },
    ],
    expect: {
      tools: ['check_print', 'print.adjust'],
      imagesToModel: 1,
      sideEffects: ['pause:bay-1'],
      args: [{ tool: 'print.adjust', label: 'pauses', check: (i) => change(i)['kind'] === 'pause' }],
      reply: [/paus/i],
      maxToolCalls: 3,
    },
  },
  {
    id: 'check-print-out-of-limits',
    title: 'A change past the limits is refused before any card',
    group: 'skill',
    prompt: "How's the print going? Crank the nozzle way up if it looks weak.",
    machine: X1C,
    objects: [],
    frames: { 'bay-1': FRAMES['midprint-clean'] },
    approve: () => true,
    script: [
      { calls: [{ name: 'check_print', args: {} }] },
      { calls: [{ name: 'print.adjust', args: { printerId: 'bay-1', change: { kind: 'nozzle_temp', celsius: 290 }, reason: 'User asked for a much hotter nozzle' } }] },
      { text: 'The print looks clean. A jump to 290 C is past what a check-in may change during a print, so I left the nozzle at 250 C.' },
    ],
    expect: { tools: ['check_print'], imagesToModel: 1, noSideEffects: true, noApprovals: true, reply: [/250/], maxToolCalls: 3 },
  },
  {
    id: 'check-print-no-camera',
    title: 'No camera: status only, ask the user to look',
    group: 'skill',
    prompt: "How's Bay 3 doing?",
    machine: X1C,
    objects: [],
    script: [
      { calls: [{ name: 'check_print', args: { printerId: 'bay-3' } }] },
      { text: 'Bay 3 is paused and has no camera, so I cannot see the plate. Can you take a look and tell me what you see?' },
    ],
    expect: { tools: ['check_print'], noSideEffects: true, noApprovals: true, reply: [/no camera/i], maxToolCalls: 2 },
  },
]
