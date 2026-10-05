// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// make_model scenarios: multi-color models built from a request and sliced. Replay only.
import type { PilotMachine } from '@slicerx/contracts'
import type { ScriptStep } from '../../src/provider/scripted'
import type { Expectation, Scenario } from '../types'
import { lazyGeom } from './c'
import type { EvalHosts } from '../harness'

const P1S: PilotMachine = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }
const withGeom = (): EvalHosts => ({ geom: lazyGeom })

const slotsOf = (i: Record<string, unknown>): string => (Array.isArray(i['parts']) ? (i['parts'] as { color?: string }[]).map((p) => String(p.color).toLowerCase()).join('|') : '')

function make(id: string, title: string, prompt: string, script: ScriptStep[], expect: Expectation): Scenario {
  return { id: `make-model-${id}`, title, group: 'skill', prompt, machine: P1S, objects: [], hosts: withGeom, script, expect: { noSideEffects: true, maxToolCalls: 3, ...expect } }
}

export const SCENARIOS: Scenario[] = [
  make(
    'logo',
    'The SlicerX logo in SlicerX black and X pink',
    'Build me a SlicerX logo in SlicerX black and X pink and slice it.',
    [
      {
        calls: [
          {
            name: 'make_model',
            args: {
              name: 'SlicerX logo',
              parts: [
                { kind: 'box', name: 'plate', sizeMm: [60, 60, 2], color: 'SlicerX black' },
                { kind: 'mark', name: 'X', mark: 'slicerx-x', widthMm: 40, heightMm: 1, onPart: 0, color: 'X pink' },
              ],
            },
          },
        ],
      },
      { text: 'The SlicerX logo is on its own plate: a SlicerX black base with the X in X pink on top. Slot 1 is black and slot 2 is pink; the time and grams per color are in the table above.' },
    ],
    {
      tools: ['make_model'],
      args: [{ tool: 'make_model', label: 'black base and pink X', check: (i) => /slicerx black/.test(slotsOf(i)) && /x pink/.test(slotsOf(i)) }],
      reply: [/black/i, /pink/i, /slot/i],
    },
  ),

  make(
    'keychain',
    'A keychain with a hole',
    'Make a keychain: a 40 by 18 mm black tag, 3 mm thick, with the X on it in pink and a 4 mm hole at one end.',
    [
      {
        calls: [
          {
            name: 'make_model',
            args: {
              name: 'X keychain',
              parts: [
                { kind: 'box', name: 'tag', sizeMm: [40, 18, 3], color: 'SlicerX black' },
                { kind: 'mark', name: 'X', mark: 'slicerx-x', widthMm: 12, heightMm: 0.8, onPart: 0, offsetMm: [-8, 0], color: 'X pink' },
              ],
              holes: [{ part: 0, diameterMm: 4, atMm: [15, 0] }],
            },
          },
        ],
      },
      { text: 'The keychain has the pink X on a black tag and a 4 mm hole at the right end. It is on its own plate and sliced.' },
    ],
    {
      tools: ['make_model'],
      args: [{ tool: 'make_model', label: 'one 4 mm hole', check: (i) => Array.isArray(i['holes']) && i['holes'].length === 1 && (i['holes'] as { diameterMm?: number }[])[0]?.diameterMm === 4 }],
      reply: [/hole/i],
    },
  ),

  make(
    'nameplate',
    'A nameplate with raised text',
    'Make a desk nameplate that says SLICERX in pink letters on a black plate.',
    [
      {
        calls: [
          {
            name: 'make_model',
            args: {
              name: 'Nameplate',
              parts: [
                { kind: 'box', name: 'plate', sizeMm: [100, 30, 3], color: 'SlicerX black' },
                { kind: 'text', name: 'letters', text: 'SLICERX', sizeMm: 14, heightMm: 1, onPart: 0, color: 'X pink' },
              ],
            },
          },
        ],
      },
      { text: 'The nameplate is a black plate with SLICERX in raised pink letters on top, sliced on its own plate.' },
    ],
    { tools: ['make_model'], args: [{ tool: 'make_model', label: 'text on the plate', check: (i) => JSON.stringify(i['parts']).includes('SLICERX') }], reply: [/pink/i, /black/i] },
  ),

  make(
    'coaster',
    'A two-color coaster',
    'Print a two-color coaster, 90 mm round, black with a blue disc inlay on top.',
    [
      {
        calls: [
          {
            name: 'make_model',
            args: {
              name: 'Coaster',
              parts: [
                { kind: 'cylinder', name: 'base', diameterMm: 90, heightMm: 4, color: 'black' },
                { kind: 'cylinder', name: 'inlay', diameterMm: 70, heightMm: 0.8, onPart: 0, color: 'blue' },
              ],
            },
          },
        ],
      },
      { text: 'The coaster is a 90 mm black base with a 70 mm blue disc on top, sliced on its own plate.' },
    ],
    { tools: ['make_model'], args: [{ tool: 'make_model', label: 'two cylinders', check: (i) => Array.isArray(i['parts']) && i['parts'].length === 2 }], reply: [/black/i, /blue/i] },
  ),

  make(
    'unknown-color',
    'A color that is not a name or hex',
    'Make a small tag in vibrant flurbo.',
    [
      { calls: [{ name: 'make_model', args: { name: 'Tag', parts: [{ kind: 'box', sizeMm: [30, 15, 2], color: 'vibrant flurbo' }] } }] },
      { text: 'I do not know the color "vibrant flurbo". Give me a name like blue, a brand color like X pink, or a hex value.' },
    ],
    { tools: ['make_model'], reply: [/flurbo/i, /hex/i] },
  ),
]
