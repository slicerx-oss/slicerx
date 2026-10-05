// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Skill scenarios: geometry (mesh analysis and repair, split to fit, orient,
// hollow, emboss, calibration models, resume planning, parts from a
// description, hole sizing and scaling with held holes). Geometry comes from
// the sx-geom build in target/ through a host that loads it on first use, so
// the browser dev harness can import this file.
import type { GeomHost } from '../../src/hosts'
import type { EvalHosts } from '../harness'
import type { Scenario } from '../types'
import { isPilotScenario } from '../functions'

/** sx-geom from the workspace build, loaded on first use (Node only). */
export const lazyGeom: GeomHost = {
  async run(op, input, signal) {
    const { evalGeom } = await import('../geom')
    const g = evalGeom()
    if (!g) throw new Error('sx-geom is not built; run cargo build -p sx-geom')
    return g.run(op, input, signal)
  },
}

const withGeom = (): EvalHosts => ({ geom: lazyGeom })

const P1S_PLA = { printer: 'bambu_p1s', material: 'pla', nozzle: 0.4 }
const A1_MINI_PLA = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }

const ALL: Scenario[] = [
  {
    id: 'skill-mesh-analyze',
    title: 'Measure a cable hook before printing',
    group: 'skill',
    prompt: 'How much does this cable hook overhang, and is the mesh watertight?',
    machine: P1S_PLA,
    objects: [{ id: 'hook', name: 'Cable hook', bboxMm: [40, 20, 60], mesh: true }],
    hosts: withGeom,
    script: [
      { calls: [{ name: 'mesh_analyze', args: { objectId: 'hook' } }] },
      { text: 'The mesh is watertight. As it sits, the top block overhangs the narrow foot, so it needs support under that ledge unless you turn it.' },
    ],
    expect: {
      tools: ['mesh_analyze'],
      args: [{ tool: 'mesh_analyze', label: 'measures the hook', check: (i) => i['objectId'] === 'hook' }],
      noSideEffects: true,
      reply: [/watertight/i, /overhang/i],
      maxToolCalls: 2,
    },
  },
  {
    id: 'skill-mesh-repair',
    title: 'Repair a bracket before slicing',
    group: 'skill',
    prompt: 'The slicer complains about this bracket mesh. Fix it.',
    machine: P1S_PLA,
    objects: [{ id: 'bracket', name: 'Bracket', bboxMm: [60, 40, 25], mesh: true }],
    hosts: withGeom,
    script: [
      { calls: [{ name: 'mesh_repair', args: { objectId: 'bracket' } }] },
      { text: 'The bracket mesh is already watertight, so I kept it as is. If the slicer still complains, the message is about something else; send me the exact warning.' },
    ],
    expect: {
      tools: ['mesh_repair'],
      noSideEffects: true,
      reply: [/watertight/i],
      maxToolCalls: 2,
    },
  },
  {
    id: 'skill-mesh-repair-no-geometry',
    title: 'Repair asked on a host without geometry',
    group: 'skill',
    prompt: 'Fix the open edges on this bracket.',
    machine: P1S_PLA,
    objects: [{ id: 'bracket', name: 'Bracket', bboxMm: [60, 40, 25], mesh: true }],
    script: [
      { calls: [{ name: 'mesh_repair', args: { objectId: 'bracket' } }] },
      { text: 'I cannot repair the mesh here: this host has no geometry engine. Open the project in the desktop app and ask again.' },
    ],
    expect: {
      tools: ['mesh_repair'],
      noSideEffects: true,
      reply: [/geometry/i],
      maxToolCalls: 2,
    },
  },
  {
    id: 'skill-split-to-fit',
    title: 'Split a tall planter for an A1 mini',
    group: 'skill',
    prompt: 'This planter is too tall for my A1 mini. Split it with dowels.',
    machine: A1_MINI_PLA,
    objects: [{ id: 'planter', name: 'Planter', bboxMm: [150, 150, 240], mesh: true }],
    hosts: withGeom,
    script: [
      { calls: [{ name: 'cut', args: { objectId: 'planter', printerModel: 'A1 mini', mode: 'compare' } }] },
      { calls: [{ name: 'cut', args: { objectId: 'planter', printerModel: 'A1 mini', mode: 'split', connector: 'dowel' } }] },
      { text: 'The planter is now two parts that each fit the A1 mini, joined with dowels that print as separate pieces. One part is not watertight where the foot meets the top block, so check it before slicing. Nothing was sent to a printer.' },
    ],
    expect: {
      tools: ['cut'],
      args: [
        { tool: 'cut', label: 'splits for the A1 mini', check: (i) => i['mode'] === 'split' && /a1\s*mini/i.test(String(i['printerModel'])) },
        { tool: 'cut', label: 'uses dowels', check: (i) => i['connector'] === 'dowel' },
      ],
      noSideEffects: true,
      reply: [/fit the a1 mini/i],
      maxToolCalls: 3,
    },
  },
  {
    id: 'skill-orient-apply',
    title: 'Orient a cable hook for the least support',
    group: 'skill',
    prompt: 'Turn this cable hook so it needs the least support, and apply it.',
    machine: P1S_PLA,
    objects: [{ id: 'hook', name: 'Cable hook', bboxMm: [40, 20, 60], mesh: true }],
    hosts: withGeom,
    script: [
      { calls: [{ name: 'orient', args: { objectId: 'hook', minSupports: true, apply: true } }] },
      { text: 'I ranked the rotations with the geometry engine and applied the one with the least support to the hook.' },
    ],
    expect: {
      tools: ['orient'],
      args: [{ tool: 'orient', label: 'applies the rotation', check: (i) => i['apply'] === true }],
      noSideEffects: true,
      reply: [/least support/i],
      maxToolCalls: 2,
    },
  },
  {
    id: 'skill-hollow',
    title: 'Hollow a planter with a drain hole',
    group: 'skill',
    prompt: 'Hollow this planter to 3 mm walls with one drain hole in the base. How much does it save?',
    machine: P1S_PLA,
    objects: [{ id: 'planter', name: 'Planter', bboxMm: [120, 120, 100], mesh: true }],
    hosts: withGeom,
    script: [
      { calls: [{ name: 'hollow', args: { objectId: 'planter', wallMm: 3, drainHoles: 1, holeDiameterMm: 5 } }] },
      { text: 'Done: 3 mm walls with a 5 mm drain hole in the base. The saving is shown both printed solid and at your current infill, which is the number that matters for FDM.' },
    ],
    expect: {
      tools: ['hollow'],
      args: [{ tool: 'hollow', label: '3 mm walls', check: (i) => i['wallMm'] === 3 }],
      citations: true,
      noSideEffects: true,
      reply: [/infill/i],
      maxToolCalls: 2,
    },
  },
  {
    id: 'skill-emboss',
    title: 'Deboss a label on an enclosure lid',
    group: 'skill',
    prompt: 'Put "BAY 2" on the top of this enclosure lid, 8 mm tall, 0.6 mm deep.',
    machine: P1S_PLA,
    objects: [{ id: 'lid', name: 'Enclosure lid', bboxMm: [180, 140, 20], mesh: true }],
    hosts: withGeom,
    script: [
      { calls: [{ name: 'emboss', args: { objectId: 'lid', text: 'BAY 2', face: 'top', sizeMm: 8, depthMm: 0.6, mode: 'deboss' } }] },
      { text: 'The label is recessed 0.6 mm into the top of the lid. At 8 mm tall the strokes are wide enough for the 0.4 mm nozzle.' },
    ],
    expect: {
      tools: ['emboss'],
      args: [{ tool: 'emboss', label: 'the right text on top', check: (i) => i['text'] === 'BAY 2' && i['face'] === 'top' }],
      noSideEffects: true,
      reply: [/nozzle/i],
      maxToolCalls: 2,
    },
  },
  {
    id: 'skill-calibrate-models',
    title: 'Calibration models for a new PETG spool',
    group: 'skill',
    prompt: 'Make me a temperature tower and a flow test for this PETG and put them in the project.',
    machine: { printer: 'bambu_p1s', material: 'petg', nozzle: 0.4 },
    objects: [{ id: 'cube', name: 'Calibration cube', bboxMm: [20, 20, 20] }],
    hosts: withGeom,
    script: [
      { calls: [{ name: 'calibrate', args: { material: 'petg', tests: ['temp-tower', 'flow'] } }] },
      { text: 'The temperature tower and the flow pads are in the project, one plate each, with the temperature per block and the flow ratio per pad listed. Nothing is queued; I will send it to a printer when you say so.' },
    ],
    expect: {
      tools: ['calibrate'],
      args: [{ tool: 'calibrate', label: 'tower and flow for PETG', check: (i) => /petg/i.test(String(i['material'])) && Array.isArray(i['tests']) && i['tests'].length === 2 }],
      forbidden: ['printer.queue'],
      citations: true,
      noSideEffects: true,
      reply: [/nothing is queued/i],
      maxToolCalls: 2,
    },
  },
  {
    id: 'skill-resume-from-layer',
    title: 'Plan a restart for a bracket stopped mid print',
    group: 'skill',
    prompt: 'My bracket print stopped. The part on the bed measures 12.1 mm. Where do I resume?',
    machine: P1S_PLA,
    objects: [{ id: 'bracket', name: 'Bracket', bboxMm: [60, 40, 25], mesh: true }],
    hosts: withGeom,
    script: [
      { calls: [{ name: 'resume_from_layer', args: { objectId: 'bracket', measuredHeightMm: 12.1 } }] },
      { text: 'Resume at layer 62, Z 12.4 mm: the measurement counts layer 61 as done. This is a plan only: producing the resume G-code needs the core start-layer option, which is not there yet, and nothing was sent to the printer.' },
    ],
    expect: {
      tools: ['resume_from_layer'],
      args: [{ tool: 'resume_from_layer', label: 'uses the measured height', check: (i) => i['measuredHeightMm'] === 12.1 }],
      forbidden: ['printer.resume', 'printer.queue'],
      noSideEffects: true,
      reply: [/layer 62/i, /plan only/i],
      maxToolCalls: 2,
    },
  },
  {
    id: 'skill-text-to-part',
    title: 'An L bracket with two M3 holes',
    group: 'skill',
    prompt: '40 mm L bracket, 20 mm wide, two M3 holes in the base, 3 mm thick.',
    machine: P1S_PLA,
    objects: [],
    hosts: withGeom,
    script: [
      {
        calls: [
          {
            name: 'text_to_part',
            args: {
              name: 'L bracket 40 mm',
              solids: [{ type: 'l_bracket', legAMm: 40, legBMm: 40, widthMm: 20, thicknessMm: 3 }],
              holes: [
                { diameterMm: 3.4, atMm: [15, 10, 0], axis: 'z' },
                { diameterMm: 3.4, atMm: [32, 10, 0], axis: 'z' },
              ],
            },
          },
        ],
      },
      { text: 'The L bracket is in the project on its own plate with both M3 clearance holes. Check the size in the viewport, then I can slice it.' },
    ],
    expect: {
      tools: ['text_to_part'],
      args: [{ tool: 'text_to_part', label: 'two holes', check: (i) => Array.isArray(i['holes']) && i['holes'].length === 2 }],
      noSideEffects: true,
      reply: [/review|check the size/i],
      maxToolCalls: 2,
    },
  },
  {
    id: 'skill-threads-and-fits',
    title: 'Heat-set inserts in an enclosure lid',
    group: 'skill',
    prompt: 'Add M3 heat-set insert holes in the four corners of this enclosure lid, from the bottom.',
    machine: P1S_PLA,
    objects: [{ id: 'lid', name: 'Enclosure lid', bboxMm: [180, 140, 20], mesh: true }],
    hosts: withGeom,
    script: [
      {
        calls: [
          {
            name: 'threads_and_fits',
            args: {
              objectId: 'lid',
              features: [
                { kind: 'insert', size: 'M3', atMm: [8, 8, 0], face: 'bottom' },
                { kind: 'insert', size: 'M3', atMm: [46, 8, 0], face: 'bottom' },
                { kind: 'insert', size: 'M3', atMm: [8, 132, 0], face: 'bottom' },
                { kind: 'insert', size: 'M3', atMm: [46, 132, 0], face: 'bottom' },
              ],
            },
          },
        ],
      },
      { text: 'The four insert holes are sized at 4.0 mm, 6.7 mm deep for standard M3 inserts. Press the inserts in with the iron at the filament temperature.' },
    ],
    expect: {
      tools: ['threads_and_fits'],
      args: [{ tool: 'threads_and_fits', label: 'four M3 inserts', check: (i) => Array.isArray(i['features']) && i['features'].length === 4 }],
      citations: true,
      noSideEffects: true,
      reply: [/4\.0 mm/i],
      maxToolCalls: 2,
    },
  },
  {
    id: 'skill-scale-with-tolerance',
    title: 'Shrink a bracket and keep its M3 holes',
    group: 'skill',
    prompt: 'Scale this bracket to 80 percent but keep the M3 clearance hole an M3 clearance hole.',
    machine: P1S_PLA,
    objects: [{ id: 'bracket', name: 'Bracket', bboxMm: [60, 40, 25], mesh: true }],
    hosts: withGeom,
    script: [
      { calls: [{ name: 'scale_with_tolerance', args: { objectId: 'bracket', scalePct: 80, hold: [{ kind: 'clearance', size: 'M3', atMm: [9, 20, 25], face: 'top' }] } }] },
      { text: 'The bracket is at 80 percent and the M3 clearance hole was cut back to full size. Run the tolerance test once so hole compensation matches your printer.' },
    ],
    expect: {
      tools: ['scale_with_tolerance'],
      args: [{ tool: 'scale_with_tolerance', label: '80 percent', check: (i) => i['scalePct'] === 80 }],
      citations: true,
      noSideEffects: true,
      reply: [/tolerance test/i],
      maxToolCalls: 2,
    },
  },
]

/** Scenarios that need the sx-geom build. */
export const GEOM_SCENARIOS = new Set(ALL.filter((s) => s.hosts === withGeom).map((s) => s.id))

/** Scenarios mimir runs. */
export const SCENARIOS: Scenario[] = ALL.filter(isPilotScenario)
/** Scenarios for jobs that are plain app functions now (evals/functions.ts). */
export const FUNCTION_SCENARIOS: Scenario[] = ALL.filter((s) => !isPilotScenario(s))
