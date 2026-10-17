// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which tip each control opens: every Simple setting and choice, every Advanced and Expert row, every Preview legend
// marker and every plate tool resolves, from the control's own tip attributes, to its own loop or still. Moved from the
// tips Playwright spec, which hovered each control to see the same thing. The loops themselves (size, sentence, play,
// pause) are in demo-loop.test.ts; one real hover per kind of tip stays in the shell journey.
import type { SettingDef } from '@slicerx/contracts'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SETTINGS } from '../src/adapters/settings'
import { DEMOS, SETTING_DEMOS } from '../src/lib/demos'
import { loadTips, resolveTip } from '../src/lib/tip-host'
import { TIPS } from '../src/lib/tips'
import { set } from '../src/state/store'
import { MARKERS } from '../src/workspaces/preview/markers'
import { Field } from '../src/workspaces/prepare/expert-settings'
import { EasySettingsPanel } from '../src/workspaces/prepare/easy-settings'

beforeAll(async () => {
  await loadTips()
})
afterAll(cleanup)

/** The tip a hover on `el` opens: the nearest element that carries one, as the tooltip host finds it. */
function tipOf(el: Element) {
  const anchor = el.closest<HTMLElement>('[data-tip], [data-tip-title]')
  expect(anchor, 'a control with a tip').not.toBeNull()
  return resolveTip(anchor!, {})
}
/** The id a loop gives its classes, which the stage's drawing is told apart by. */
const loopOf = async (tip: ReturnType<typeof tipOf>) => (await tip?.demo?.stage?.())?.id

const def = (key: string): SettingDef => SETTINGS.find((d) => d.key === key)!

/** A setting's row, drawn alone, and the tip its label opens. */
function rowTip(key: string) {
  const { container } = render(createElement('ul', null, createElement(Field, { def: def(key), value: def(key).default as never, overridden: false })))
  const label = container.querySelector(`li[data-key="${key}"] label`) ?? container.querySelector('label')
  expect(label, key).not.toBeNull()
  const tip = tipOf(label!)
  cleanup()
  return tip
}

// Advanced and Expert rows and the class prefix of the loop each shows.
const LOOPS: readonly (readonly [key: string, loop: string])[] = [
  ['print_flow_ratio', 'afr'], ['fuzzy_skin', 'afz'], ['ironing_type', 'air'], ['draft_shield', 'ads'],
  ['elefant_foot_compensation', 'aef'], ['enable_arc_fitting', 'aaf'], ['hole_to_polyhole', 'aph'], ['bridge_speed', 'abg'],
  ['internal_bridge_speed', 'aib'], ['prime_tower_width', 'bqpw'], ['prime_tower_infill_gap', 'bqpg'], ['prime_tower_brim_width', 'bqpb'],
  ['raft_contact_distance', 'bqrc'], ['raft_expansion', 'bqre'], ['raft_first_layer_density', 'bqrd'], ['raft_first_layer_expansion', 'bqrx'],
  ['max_volumetric_extrusion_rate_slope', 'bqrs'], ['max_volumetric_extrusion_rate_slope_segment_length', 'bqrg'], ['extrusion_rate_smoothing_external_perimeter_only', 'bqro'], ['seam_slope_type', 'bqsc'],
  ['seam_slope_min_length', 'bqsl'], ['seam_slope_steps', 'bqss'], ['seam_slope_start_height', 'bqsh'], ['seam_slope_entire_loop', 'bqsx'],
  ['scarf_joint_flow_ratio', 'bqsf'], ['scarf_angle_threshold', 'bqsa'], ['seam_position', 'bqsp'], ['seam_gap', 'bqsg'],
  ['staggered_inner_seams', 'bqsi'], ['wipe_on_loops', 'bqwl'], ['wipe_before_external_loop', 'bqwb'], ['skeleton_infill_density', 'bqkd'],
  ['skeleton_infill_line_width', 'bqkw'], ['skin_infill_density', 'bqnd'], ['skin_infill_depth', 'bqnp'], ['skin_infill_line_width', 'bqnw'],
  ['skirt_height', 'brkh'], ['skirt_start_angle', 'brka'], ['skirt_type', 'brkt'], ['smart_layer_max_height', 'brlx'],
  ['smart_layer_min_height', 'brln'], ['smart_layer_max_step_ratio', 'brlr'], ['smart_layer_smoothing', 'brls'], ['smart_layer_smoothing_radius', 'brlo'],
  ['slicing_mode', 'brsm'], ['solid_infill_direction', 'brsd'], ['outer_wall_speed', 'bros'], ['inner_wall_speed', 'bris'],
  ['sparse_infill_speed', 'brps'], ['internal_solid_infill_speed', 'brds'], ['top_surface_speed', 'brts'], ['gap_infill_speed', 'brgs'],
  ['small_perimeter_threshold', 'brsh'], ['travel_speed', 'brvs'], ['initial_layer_speed', 'brfs'], ['initial_layer_infill_speed', 'brfi'],
  ['slow_down_layers', 'brsl'], ['spiral_mode', 'brvm'], ['spiral_mode_smooth', 'brvo'], ['spiral_starting_flow_ratio', 'brva'],
  ['spiral_finishing_flow_ratio', 'brvf'], ['support_speed', 'brus'], ['support_interface_speed', 'brui'], ['support_type', 'brty'],
  ['support_critical_regions_only', 'brcr'], ['support_threshold_angle', 'brth'], ['support_angle', 'brsn'], ['support_base_pattern', 'brbp'],
  ['support_base_pattern_spacing', 'brbs'], ['support_interface_pattern', 'brip'], ['support_bottom_interface_spacing', 'brbi'], ['support_expansion', 'brex'],
  ['support_ironing', 'btsi'], ['support_ironing_flow', 'btsf'], ['support_ironing_pattern', 'btsp'], ['support_ironing_spacing', 'btss'],
  ['support_object_first_layer_gap', 'btsg'], ['support_on_build_plate_only', 'btsb'], ['support_remove_small_overhang', 'btsr'], ['tree_support_branch_angle', 'btta'],
  ['tree_support_angle_slow', 'btal'], ['tree_support_branch_diameter', 'bttd'], ['tree_support_branch_diameter_angle', 'bttg'], ['tree_support_branch_distance', 'bttb'],
  ['tree_support_tip_diameter', 'bttt'], ['tree_support_top_rate', 'bttr'], ['tree_support_wall_count', 'bttw'], ['tree_support_brim_width', 'bttm'],
  ['wall_sequence', 'btwo'], ['is_infill_first', 'btif'], ['wall_direction', 'btwd'], ['wall_transition_length', 'bttl'],
  ['wall_transition_angle', 'bttn'], ['wall_transition_filter_deviation', 'bttf'], ['wave_overhangs', 'bwvo'], ['wave_overhang_line_spacing', 'bwvs'],
  ['wave_overhang_perimeter_overlap', 'bwvl'], ['wave_overhang_print_speed', 'bwvp'], ['wave_overhang_flow_mm3_per_mm', 'bwvf'], ['wave_overhang_max_iterations', 'bwvi'],
  ['slowdown_for_curled_perimeters', 'brcw'], ['solid_infill_rotate_template', 'brsr'], ['small_perimeter_speed', 'brss'], ['wipe_speed', 'bwws'],
  ['wipe_tower_rotation_angle', 'bwtr'], ['wipe_tower_extra_spacing', 'bwts'], ['wipe_tower_extra_flow', 'bwtf'], ['wipe_tower_max_purge_speed', 'bwtm'],
  ['wipe_tower_no_sparse_layers', 'bwtn'], ['wipe_tower_wall_type', 'bwtw'], ['wipe_tower_filament', 'bwtl'], ['wipe_tower_bridging', 'bwtb'],
  ['xy_contour_compensation', 'bwxc'], ['xy_hole_compensation', 'bwxh'], ['interlocking_beam', 'ail'],
]

// Rows that show a still, by the still's id: the figure's label is its sentence.
const STILLS: readonly (readonly [key: string, still: string])[] = [
  ['line_width', 'still-line-width'], ['outer_wall_line_width', 'still-line-width-outer'], ['inner_wall_line_width', 'still-line-width-inner'],
  ['top_surface_line_width', 'still-line-width-top'], ['sparse_infill_line_width', 'still-line-width-sparse'], ['internal_solid_infill_line_width', 'still-line-width-solid'],
  ['initial_layer_line_width', 'still-line-width-first'], ['top_shell_layers', 'still-shells-top'], ['top_shell_thickness', 'still-shells-top'],
  ['bottom_shell_layers', 'still-shells-bottom'], ['bottom_shell_thickness', 'still-shells-bottom'], ['initial_layer_print_height', 'still-first-layer-height'],
  ['top_surface_pattern', 'still-surface-pattern-top'], ['bottom_surface_pattern', 'still-surface-pattern-bottom'], ['sparse_infill_pattern', 'still-sparse-pattern'],
  ['skirt_distance', 'still-skirt-distance'], ['skirt_loops', 'still-skirt-loops'], ['min_skirt_length', 'still-skirt-length'],
  ['brim_object_gap', 'still-brim-gap'], ['raft_layers', 'still-raft-layers'], ['support_top_z_distance', 'still-support-top-gap'],
  ['support_bottom_z_distance', 'still-support-bottom-gap'], ['support_object_xy_distance', 'still-support-xy-gap'], ['support_interface_top_layers', 'still-support-interface-layers'],
  ['support_interface_spacing', 'still-support-interface-spacing'], ['support_style', 'still-support-style'], ['only_one_wall_top', 'still-one-wall-top'],
  ['only_one_wall_first_layer', 'still-one-wall-first'], ['ironing_angle', 'still-ironing-angle'], ['ironing_angle_fixed', 'still-ironing-angle'],
  ['top_color_penetration_layers', 'still-paint-depth-top'], ['bottom_color_penetration_layers', 'still-paint-depth-bottom'], ['support_line_width', 'still-line-width-support'],
  ['bridge_line_width', 'still-line-width-bridge'],
]

// The sentence under each still.
const STILL_TEXT: Readonly<Record<string, string>> = {
  'still-line-width': "Every line in a cut part, seen end on. A line with no width of its own prints at the default, here 0.42 mm.",
  'still-line-width-outer': "The outer wall lines, picked out in a cut part, print 0.42 mm wide. Narrower gives finer detail.",
  'still-line-width-inner': "The inner wall lines, picked out in a cut part, print 0.45 mm wide.",
  'still-line-width-sparse': "The sparse infill lines, picked out in a cut part, print 0.45 mm wide. Wider lines fill faster and make stronger infill.",
  'still-line-width-solid': "The solid infill under the top, picked out in a cut part, prints 0.42 mm wide.",
  'still-line-width-top': "The top surface lines, picked out in a cut part, print 0.42 mm wide. Narrower lines give a finer top.",
  'still-line-width-first': "The first layer lines, picked out in a cut part, print 0.50 mm wide. Wider first lines grip the bed better.",
  'still-shells-top': "The solid layers on top of the part: 4 layers of 0.2 mm make a top 0.8 mm thick over the infill.",
  'still-shells-bottom': "The solid layers at the bottom of the part: 3 layers of 0.2 mm make a bottom 0.6 mm thick.",
  'still-first-layer-height': "The first layer can print thicker than the rest, here 0.3 mm under 0.2 mm layers, which forgives a bed that is not quite level.",
  'still-surface-pattern-top': "Top surface patterns, left to right: monotonic, concentric, Hilbert curve and Archimedean chords.",
  'still-surface-pattern-bottom': "Bottom surface patterns on the first layer, left to right: monotonic, concentric, Hilbert curve and Archimedean chords.",
  'still-sparse-pattern': "Sparse infill patterns at one density, left to right: grid, gyroid, honeycomb and lightning.",
  'still-skirt-distance': "The skirt sits this far out from the part or its brim, here 2 mm.",
  'still-skirt-loops': "The loops drawn around the parts before the print starts, here 2. They prime the nozzle and show the first layer is level.",
  'still-skirt-length': "Skirt loops are added until at least this much filament has gone through the nozzle, here 100 mm.",
  'still-brim-gap': "A small gap between the part and its brim, here 0.1 mm, so the brim snaps off cleanly.",
  'still-raft-layers': "The part prints on 3 raft layers, which come away after the print.",
  'still-support-top-gap': "The gap between the top of the support and the part above it, here 0.2 mm.",
  'still-support-bottom-gap': "The gap where support stands on the part below it, here 0.2 mm.",
  'still-support-xy-gap': "The sideways gap between support and the wall of the part, here 0.35 mm.",
  'still-support-interface-layers': "The dense layers at the top of the support, right under the part, here 3.",
  'still-support-interface-spacing': "The gap between the interface lines under the part, here 0.5 mm. Smaller gives a smoother underside.",
  'still-support-style': "The same overhang held up by grid, snug, organic and tree slim support, left to right.",
  'still-one-wall-top': "The same top with 3 walls and with 1. With one wall the top lines reach almost to the edge.",
  'still-one-wall-first': "The first layer with 3 walls and with 1. With one wall the bottom lines reach almost to the edge.",
  'still-ironing-angle': "With a fixed angle, ironing runs at that angle, here 0\u00b0, instead of along the top lines.",
  'still-paint-depth-top': "A painted top colors this many layers down from the top surface, here 3.",
  'still-paint-depth-bottom': "A painted bottom colors this many layers up from the bottom surface, here 3.",
  'still-line-width-support': "The support lines, picked out under a ledge, print at the default width when this is 0, here 0.42 mm.",
  'still-line-width-bridge': "The bridge lines over the gap, seen end on, print 0.40 mm wide, 100% of a 0.4 mm nozzle.",
  'still-model-tree': "Each entry in the tree is one thing in the view: a sketch lies on its plane, a body stands on the plate.",
  'still-timeline': "Steps run left to right. Move the marker back and the part shows as it was there; the steps after it are grayed.",
  'still-pick-object': "Picking objects takes the whole part.",
  'still-pick-face': "Picking faces takes one face of the part.",
  'still-pick-edge': "Picking edges takes one edge, where two faces meet.",
  'still-sketch-status': "Constraint glyphs sit by the lines they hold. The status line says how much of the sketch can still move.",
  'still-named-values': "Name a value once, type its name in a size such as a push and pull distance, and the part follows when the value changes.",
  'still-hollow': "Hollowing empties the inside and leaves an even wall all around, here 2 mm, which saves material and print time.",
  'still-repair': "Repair closes open edges and turns flipped faces to point outward, so the mesh slices as a closed solid.",
  'still-measure': "Pick two places: the panel gives the distance between them and how far apart they are along X, Y and Z.",
}

describe('settings rows', () => {
  it('open their own loop', async () => {
    for (const [key, loop] of LOOPS) {
      expect(SETTING_DEMOS[key], key).toBeDefined()
      expect(await loopOf(rowTip(key)), key).toBe(loop)
    }
  })

  it('open their own still, with its sentence', () => {
    for (const [key, still] of STILLS) {
      const tip = rowTip(key)
      expect(tip?.demo, key).toBe(DEMOS[still])
      expect(tip?.demo?.body, key).toBe(STILL_TEXT[still])
    }
    expect(rowTip('top_surface_density')?.demo?.body).toMatch(/pinholes/)
    for (const [still, text] of Object.entries(STILL_TEXT)) expect(DEMOS[still]?.body, still).toBe(text)
  })
})

describe('Simple settings', () => {
  beforeEach(() => set({ settingsMode: 'advanced', goal: 'standard' }))

  it('open the loop of the setting, each of its choices and the speed preset', async () => {
    const { container } = render(createElement(EasySettingsPanel))
    const rows = [...container.querySelectorAll<HTMLElement>('.srow')]
    const row = (text: string) => rows.find((r) => r.textContent?.includes(text))!
    const at = (sel: string) => container.querySelector(sel)!
    expect(await loopOf(tipOf(row('Layer height').querySelector('.srow-h')!))).toBe('lh')
    // layer height has a still figure too; the loop takes its place, so the tip shows one picture
    expect(tipOf(row('Layer height').querySelector('.srow-h')!)?.rows).toBeUndefined()
    expect(await loopOf(tipOf(at('label[for="easy-strength"]')))).toBe('st')
    expect(await loopOf(tipOf(at('label[for="easy-speed"]')))).toBe('sp')
    expect(await loopOf(tipOf(at('output[for="easy-speed"]')))).toBe('sd')
    const supports = row('Supports')
    expect(await loopOf(tipOf(supports.querySelector('.srow-h')!))).toBe('su')
    const choice = (name: string) => [...supports.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => r.textContent?.trim() === name)!
    expect(await loopOf(tipOf(choice('Off')))).toBe('so')
    expect(await loopOf(tipOf(choice('Auto')))).toBe('sa')
    expect(await loopOf(tipOf(choice('Painted')))).toBe('sn')
    expect(await loopOf(tipOf(at('label[for="easy-brim"]')))).toBe('br')
    await act(async () => undefined)
  })
})

describe('plate tools and the legend', () => {
  it('open the loop of each plate tool', async () => {
    for (const [tool, loop] of [['tool.move', 'mv'], ['tool.rotate', 'ro'], ['tool.scale', 'sc'], ['tool.placeOnFace', 'lf']] as const) {
      const entry = TIPS[tool] as { demo?: string }
      expect(await DEMOS[entry.demo!]!.stage!().then((t) => t.id), tool).toBe(loop)
    }
  })

  it('open the loop of each Preview legend marker', async () => {
    for (const [label, loop] of [['Retractions', 'pmr'], ['Seams', 'pms'], ['Z hops', 'pmz'], ['Wipes', 'pmw'], ['Tool changes', 'pmt'], ['Pauses', 'pmp']] as const) {
      const marker = MARKERS.find((m) => m.label === label)!
      expect(await DEMOS[marker.demo]!.stage!().then((t) => t.id), label).toBe(loop)
    }
  })
})
