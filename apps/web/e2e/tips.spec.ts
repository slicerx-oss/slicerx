// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A tip never covers the next thing a person presses: it takes no clicks, and it closes once the pointer leaves its
// control, even when the pointer crosses the tip on the way.
import { type Locator, type Page } from '@playwright/test'
import { command, facePick, freshBox, openStudio, pick, pushTop, sketchAt, toolPanel } from './cad-helpers'
import { expect, plateReady, test } from './fixtures'

test('the lock button\'s tip closes as the pointer moves to the name under it, and the name takes the click', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', printerId: 'bay-1', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  const row = page.getByTestId('object-row').first()
  const name = row.getByTestId('object-select')
  const lock = row.getByTestId('object-lock')
  await page.keyboard.press('Escape')
  await expect(name).toHaveAttribute('aria-pressed', 'false')
  await row.locator('.obj-row').hover()
  await lock.hover()
  const tip = page.locator('#sx-tip')
  await expect(tip).toContainText('Keep it from moving')
  // The tip takes no pointer: a press where it is drawn lands on what is under it.
  const t = (await tip.boundingBox())!
  const [cx, cy] = [t.x + t.width / 2, t.y + t.height / 2]
  expect(await tip.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
  expect(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x!, y!)?.closest('#sx-tip')), [cx, cy])).toBe(false)
  // Across the tip to the name: the lock's tip closes once the pointer leaves the button, and the name takes the click.
  await page.mouse.move(cx, cy, { steps: 4 })
  await expect(tip.filter({ hasText: 'Keep it from moving' })).toHaveCount(0)
  const n = (await name.boundingBox())!
  await page.mouse.click(n.x + n.width / 2, n.y + n.height / 2)
  await expect(name).toHaveAttribute('aria-pressed', 'true')
})

test('a tip in the settings sidebar opens beside it, level with its control, and covers nothing in the sidebar', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', printerId: 'bay-1', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  const pane = (await page.locator('.pane[data-side="left"]').boundingBox())!
  const tip = page.locator('#sx-tip')
  const beside = async (anchor: Locator, text: string) => {
    await anchor.hover()
    await expect(tip).toContainText(text)
    await expect(tip).toHaveAttribute('data-ready', 'true')
    const t = (await tip.boundingBox())!
    const a = (await anchor.boundingBox())!
    // clear of the sidebar, so the next row and the control under it stay in view
    expect(t.x).toBeGreaterThanOrEqual(pane.x + pane.width)
    // level with its control
    expect(t.y).toBeLessThanOrEqual(a.y + a.height)
    expect(t.y + t.height).toBeGreaterThanOrEqual(a.y)
    await page.mouse.move(pane.x + pane.width + 300, 40)
    await expect(tip).toHaveCount(0)
  }
  // sleipnir on the layer height, over Supports' segment before
  await beside(page.locator('#easy-layer'), 'sleipnir changes the layer height')
  // aegis on the wall generator: the option keeps its name, and its tip names it over the longer copy
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ expertOpen: true }))
  const aegis = page.locator('[data-key="wall_generator"]').getByRole('radio', { name: 'aegis' })
  // scrolled into view inside the sidebar only, so the page itself stays put
  await aegis.evaluate((el) => {
    const body = el.closest('.sx-rail-body')!
    body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - 120
  })
  await beside(aegis, 'aegis varies wall width')
})

test('a tip on a row of the Preview legend opens beside the legend and covers none of its rows', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The legend is not drawn at phone widths')
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced' }))
  })
  await page.goto('./')
  await plateReady(page)
  await page.getByRole('button', { name: 'Slice plate' }).click()
  const legend = page.getByRole('list', { name: 'Toolpath legend' })
  const rows = legend.locator('.legend-markers label')
  await expect(rows.nth(1)).toBeVisible({ timeout: 40_000 })
  const tip = page.locator('#sx-tip')
  const n = await rows.count()
  for (let i = 0; i < n - 1; i++) {
    await rows.nth(i).hover()
    await expect(tip).toHaveAttribute('data-ready', 'true')
    const t = (await tip.boundingBox())!
    const l = (await legend.boundingBox())!
    const next = (await rows.nth(i + 1).boundingBox())!
    const clear = (b: { x: number; y: number; width: number; height: number }) => t.x >= b.x + b.width || t.x + t.width <= b.x || t.y >= b.y + b.height || t.y + t.height <= b.y
    // the next row, and every other row of the legend, stays in view
    expect(clear(next), `tip of row ${i} over the next row`).toBe(true)
    expect(clear(l), `tip of row ${i} over the legend`).toBe(true)
    await page.mouse.move(5, 5)
    await expect(tip).toHaveCount(0)
  }
})

test('a tip with a loop holds its size while the loop loads, waits on its finished frame, then plays, in either theme', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', printerId: 'bay-1', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  const tip = page.locator('#sx-tip')
  const stage = tip.locator('.sx-stage')
  await page.locator('#easy-layer').hover()
  await expect(tip).toContainText('sleipnir')
  await expect(tip).toHaveAttribute('data-ready', 'true')
  // The box is there at once, at the stage's size, so the tip is the same height before and after the loop draws.
  await expect(stage).toBeVisible()
  // The tip scales in from 98% (sx-tip-in), so it is measured once that has finished: a box read mid-entrance is 2%
  // smaller and reads as a tip that grew.
  await tip.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  const first = (await tip.boundingBox())!
  await expect(stage.locator('svg.sxs')).toBeVisible()
  // It plays from the media stage on.
  await expect(stage).toHaveAttribute('data-play', 'true')
  const state = () => stage.locator('.s-a').first().evaluate((el) => getComputedStyle(el).animationPlayState)
  await expect.poll(state).toBe('running')
  const later = (await tip.boundingBox())!
  expect(Math.round(later.height)).toBe(Math.round(first.height))
  expect(Math.round(later.width)).toBe(Math.round(first.width))
  // Dark and light follow the theme: the stage's own tokens change with the root's color scheme.
  const ink = () => stage.evaluate((el) => getComputedStyle(el).getPropertyValue('--stage-t1').trim())
  const dark = await ink()
  await page.evaluate(() => document.documentElement.style.setProperty('color-scheme', 'light'))
  await expect.poll(ink).not.toBe(dark)
  await page.evaluate(() => document.documentElement.style.removeProperty('color-scheme'))
  await expect.poll(ink).toBe(dark)
})

test('each Simple setting, each of its choices and each plate tool opens its own loop and plays it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    // Advanced keeps the Simple rows open (Strength, Speed and Brim sit behind More in Simple)
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', printerId: 'bay-1', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  const tip = page.locator('#sx-tip')
  const stage = tip.locator('.sx-stage')
  const away = async () => {
    await page.mouse.move(5, 5)
    await expect(tip).toHaveCount(0)
  }
  // each anchor's loop id is the class prefix of its drawing, so the loop on show is told apart by it
  const plays = async (anchor: Locator, text: string, loopId: string) => {
    await anchor.hover()
    await expect(tip).toContainText(text)
    await expect(stage.locator('svg.sxs')).toBeVisible()
    await expect(stage).toHaveAttribute('data-play', 'true')
    await expect(stage.locator(`[class*="${loopId}-"]`).first()).toBeAttached()
    await away()
  }
  const rows = page.locator('.srow')
  // layer height has a still figure too; the loop takes its place, so the tip shows one picture
  await rows.filter({ hasText: 'Layer height' }).locator('.srow-h').hover()
  await expect(stage.locator('svg.sxs')).toBeVisible()
  await expect(tip.locator('.sx-tip-fig')).toHaveCount(0)
  await away()
  await plays(rows.filter({ hasText: 'Layer height' }).locator('.srow-h'), 'Layer height', 'lh')
  await plays(page.locator('label[for="easy-strength"]'), 'Adds walls and infill', 'st')
  await plays(page.locator('label[for="easy-speed"]'), 'How fast the printer moves', 'sp')
  await plays(page.locator('output[for="easy-speed"]'), 'The preset speeds', 'sd')
  const supports = rows.filter({ hasText: 'Supports' })
  await plays(supports.locator('.srow-h'), 'Supports', 'su')
  await plays(supports.getByRole('radio', { name: 'Off' }), 'No supports', 'so')
  await plays(supports.getByRole('radio', { name: 'Auto' }), 'Organic tree supports', 'sa')
  await plays(supports.getByRole('radio', { name: 'Painted' }), 'Only where you paint support', 'sn')
  await plays(page.locator('label[for="easy-brim"]'), 'flat rings around the first layer', 'br')
  const tools = page.getByRole('toolbar', { name: 'Plate tools' })
  await plays(tools.getByRole('button', { name: 'Move', exact: true }), 'Drag the model across the plate', 'mv')
  await plays(tools.getByRole('button', { name: 'Rotate', exact: true }), 'Drag a ring', 'ro')
  await plays(tools.getByRole('button', { name: 'Scale', exact: true }), 'Resize the model', 'sc')
  await plays(tools.getByRole('button', { name: 'Lay on face', exact: true }), 'Pick a face', 'lf')
})

test('an Advanced setting row opens the loop of its drawing and plays it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', printerId: 'bay-1', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ expertOpen: true }))
  const tip = page.locator('#sx-tip')
  const stage = tip.locator('.sx-stage')
  // setting key, its name to search for (the settings sit behind tabs), then the class prefix of the loop its row shows
  for (const [key, name, loopId] of [['print_flow_ratio', 'Print flow ratio', 'afr'], ['fuzzy_skin', 'Fuzzy skin', 'afz'], ['ironing_type', 'Ironing type', 'air'], ['draft_shield', 'Draft shield', 'ads'], ['elefant_foot_compensation', 'Elephant foot', 'aef'], ['enable_arc_fitting', 'Arc fitting', 'aaf'], ['hole_to_polyhole', 'polyholes', 'aph'], ['top_surface_density', 'Top surface density', null]] as const) {
    await page.locator('#expert-search').fill(name)
    const row = page.locator(`li[data-key="${key}"]`).first()
    await row.scrollIntoViewIfNeeded()
    await row.locator('label').first().hover()
    await expect(stage.locator('svg.sxs'), key).toBeVisible()
    await expect(stage).toHaveAttribute('data-play', 'true')
    // a still has nothing that moves, so it is told apart by its label instead of a loop's classes
    if (loopId) await expect(stage.locator(`[class*="${loopId}-"]`).first(), key).toBeAttached()
    else await expect(stage, key).toHaveAttribute('aria-label', /pinholes/)
    await page.mouse.move(5, 5)
    await expect(tip).toHaveCount(0)
  }
})

/** Hovers each setting row in the Expert panel (found by its key) and checks its tip plays the loop with that class
 *  prefix, or for a still (no loop id), shows the figure with that label. */
async function rowsPlay(page: Page, rows: readonly (readonly [key: string, loopId: string | null, label?: string])[]): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'expert', printerId: 'bay-1', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ expertOpen: true }))
  const tip = page.locator('#sx-tip')
  const stage = tip.locator('.sx-stage')
  for (const [key, loopId, label] of rows) {
    await page.locator('#expert-search').fill(key)
    const row = page.locator(`li[data-key="${key}"]`).first()
    await row.scrollIntoViewIfNeeded()
    await row.locator('label').first().hover()
    await expect(stage.locator('svg.sxs'), key).toBeVisible()
    await expect(stage).toHaveAttribute('data-play', 'true')
    if (loopId) await expect(stage.locator(`[class*="${loopId}"]`).first(), key).toBeAttached()
    else await expect(stage, key).toHaveAttribute('aria-label', label ?? '')
    await page.mouse.move(5, 5)
    await expect(tip).toHaveCount(0)
  }
}

test('Advanced rows from prime tower to extrusion rate smoothing play their own loops', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await rowsPlay(page, [['prime_tower_width', 'bqpw'], ['prime_tower_infill_gap', 'bqpg'], ['prime_tower_brim_width', 'bqpb'], ['raft_contact_distance', 'bqrc'], ['raft_expansion', 'bqre'], ['raft_first_layer_density', 'bqrd'], ['raft_first_layer_expansion', 'bqrx'], ['max_volumetric_extrusion_rate_slope', 'bqrs'], ['max_volumetric_extrusion_rate_slope_segment_length', 'bqrg'], ['extrusion_rate_smoothing_external_perimeter_only', 'bqro']])
})

test('Advanced rows from deretraction speed to seam position play their own loops', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await rowsPlay(page, [['seam_slope_type', 'bqsc'], ['seam_slope_min_length', 'bqsl'], ['seam_slope_steps', 'bqss'], ['seam_slope_start_height', 'bqsh'], ['seam_slope_entire_loop', 'bqsx'], ['scarf_joint_flow_ratio', 'bqsf'], ['scarf_angle_threshold', 'bqsa'], ['seam_position', 'bqsp']])
})

test('Advanced rows from seam gap to smart layer max step ratio play their own loops', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await rowsPlay(page, [['seam_gap', 'bqsg'], ['staggered_inner_seams', 'bqsi'], ['wipe_on_loops', 'bqwl'], ['wipe_before_external_loop', 'bqwb'], ['skeleton_infill_density', 'bqkd'], ['skeleton_infill_line_width', 'bqkw'], ['skin_infill_density', 'bqnd'], ['skin_infill_depth', 'bqnp'], ['skin_infill_line_width', 'bqnw'], ['skirt_height', 'brkh'], ['skirt_start_angle', 'brka'], ['skirt_type', 'brkt'], ['smart_layer_max_height', 'brlx'], ['smart_layer_min_height', 'brln'], ['smart_layer_max_step_ratio', 'brlr']])
})

test('Advanced rows from smart layer smoothing to travel speed play their own loops', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await rowsPlay(page, [['smart_layer_smoothing', 'brls'], ['smart_layer_smoothing_radius', 'brlo'], ['slicing_mode', 'brsm'], ['solid_infill_direction', 'brsd'], ['outer_wall_speed', 'bros'], ['inner_wall_speed', 'bris'], ['sparse_infill_speed', 'brps'], ['internal_solid_infill_speed', 'brds'], ['top_surface_speed', 'brts'], ['gap_infill_speed', 'brgs'], ['small_perimeter_threshold', 'brsh'], ['travel_speed', 'brvs']])
})

test('Advanced rows from initial layer speed to support angle play their own loops', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await rowsPlay(page, [['initial_layer_speed', 'brfs'], ['initial_layer_infill_speed', 'brfi'], ['slow_down_layers', 'brsl'], ['spiral_mode', 'brvm'], ['spiral_mode_smooth', 'brvo'], ['spiral_starting_flow_ratio', 'brva'], ['spiral_finishing_flow_ratio', 'brvf'], ['support_speed', 'brus'], ['support_interface_speed', 'brui'], ['support_type', 'brty'], ['support_critical_regions_only', 'brcr'], ['support_threshold_angle', 'brth'], ['support_angle', 'brsn']])
})

test('Advanced rows from support base pattern to tree support branch angle play their own loops', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await rowsPlay(page, [['support_base_pattern', 'brbp'], ['support_base_pattern_spacing', 'brbs'], ['support_interface_pattern', 'brip'], ['support_bottom_interface_spacing', 'brbi'], ['support_expansion', 'brex'], ['support_ironing', 'btsi'], ['support_ironing_flow', 'btsf'], ['support_ironing_pattern', 'btsp'], ['support_ironing_spacing', 'btss'], ['support_object_first_layer_gap', 'btsg'], ['support_on_build_plate_only', 'btsb'], ['support_remove_small_overhang', 'btsr'], ['tree_support_branch_angle', 'btta']])
})

test('Advanced rows from tree support angle slow to wall transition filter deviation play their own loops', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await rowsPlay(page, [['tree_support_angle_slow', 'btal'], ['tree_support_branch_diameter', 'bttd'], ['tree_support_branch_diameter_angle', 'bttg'], ['tree_support_branch_distance', 'bttb'], ['tree_support_tip_diameter', 'bttt'], ['tree_support_top_rate', 'bttr'], ['tree_support_wall_count', 'bttw'], ['tree_support_brim_width', 'bttm'], ['wall_sequence', 'btwo'], ['is_infill_first', 'btif'], ['wall_direction', 'btwd'], ['wall_transition_length', 'bttl'], ['wall_transition_angle', 'bttn'], ['wall_transition_filter_deviation', 'bttf']])
})

test('Advanced rows from chamber temperature to wipe distance play their own loops', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await rowsPlay(page, [['wave_overhangs', 'bwvo'], ['wave_overhang_line_spacing', 'bwvs'], ['wave_overhang_perimeter_overlap', 'bwvl'], ['wave_overhang_print_speed', 'bwvp'], ['wave_overhang_flow_mm3_per_mm', 'bwvf'], ['wave_overhang_max_iterations', 'bwvi']])
})

test('Expert rows for a switch list, a text template and a number or percent play their own loops', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await rowsPlay(page, [['slowdown_for_curled_perimeters', 'brcw'], ['solid_infill_rotate_template', 'brsr'], ['small_perimeter_speed', 'brss']])
})

test('Advanced rows from wipe speed to z offset play their own loops', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await rowsPlay(page, [['wipe_speed', 'bwws'], ['wipe_tower_rotation_angle', 'bwtr'], ['wipe_tower_extra_spacing', 'bwts'], ['wipe_tower_extra_flow', 'bwtf'], ['wipe_tower_max_purge_speed', 'bwtm'], ['wipe_tower_no_sparse_layers', 'bwtn'], ['wipe_tower_wall_type', 'bwtw'], ['wipe_tower_filament', 'bwtl'], ['wipe_tower_bridging', 'bwtb'], ['xy_contour_compensation', 'bwxc'], ['xy_hole_compensation', 'bwxh']])
})

test('Advanced rows from solid layers to one nozzle show their own stills', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await rowsPlay(page, [['top_bottom_infill_wall_overlap', null, 'A block cut open; the bottom, top and one chosen layer in between print solid, the rest sparse.'], ['internal_solid_infill_pattern', null, 'Lines, grid, triangles and a gyroid-like wave, each on its own tile.'], ['support_interface_bottom_layers', null, 'A cut through support between two parts of a print; the dense interface layers touch the part above and, at the bottom, the part below.']])
})

// a still is told apart by its figure's label, the sentence under it
const STILL_TIPS = {
  'still-line-width': 'Every line in a cut part, seen end on. A line with no width of its own prints at the default, here 0.42 mm.',
  'still-line-width-outer': 'The outer wall lines, picked out in a cut part, print 0.42 mm wide. Narrower gives finer detail.',
  'still-line-width-inner': 'The inner wall lines, picked out in a cut part, print 0.45 mm wide.',
  'still-line-width-sparse': 'The sparse infill lines, picked out in a cut part, print 0.45 mm wide. Wider lines fill faster and make stronger infill.',
  'still-line-width-solid': 'The solid infill under the top, picked out in a cut part, prints 0.42 mm wide.',
  'still-line-width-top': 'The top surface lines, picked out in a cut part, print 0.42 mm wide. Narrower lines give a finer top.',
  'still-line-width-first': 'The first layer lines, picked out in a cut part, print 0.50 mm wide. Wider first lines grip the bed better.',
  'still-shells-top': 'The solid layers on top of the part: 4 layers of 0.2 mm make a top 0.8 mm thick over the infill.',
  'still-shells-bottom': 'The solid layers at the bottom of the part: 3 layers of 0.2 mm make a bottom 0.6 mm thick.',
  'still-first-layer-height': 'The first layer can print thicker than the rest, here 0.3 mm under 0.2 mm layers, which forgives a bed that is not quite level.',
  'still-surface-pattern-top': 'Top surface patterns, left to right: monotonic, concentric, Hilbert curve and Archimedean chords.',
  'still-surface-pattern-bottom': 'Bottom surface patterns on the first layer, left to right: monotonic, concentric, Hilbert curve and Archimedean chords.',
  'still-sparse-pattern': 'Sparse infill patterns at one density, left to right: grid, gyroid, honeycomb and lightning.',
  'still-skirt-distance': 'The skirt sits this far out from the part or its brim, here 2 mm.',
  'still-skirt-loops': 'The loops drawn around the parts before the print starts, here 2. They prime the nozzle and show the first layer is level.',
  'still-skirt-length': 'Skirt loops are added until at least this much filament has gone through the nozzle, here 100 mm.',
  'still-brim-gap': 'A small gap between the part and its brim, here 0.1 mm, so the brim snaps off cleanly.',
  'still-raft-layers': 'The part prints on 3 raft layers, which come away after the print.',
  'still-support-top-gap': 'The gap between the top of the support and the part above it, here 0.2 mm.',
  'still-support-bottom-gap': 'The gap where support stands on the part below it, here 0.2 mm.',
  'still-support-xy-gap': 'The sideways gap between support and the wall of the part, here 0.35 mm.',
  'still-support-interface-layers': 'The dense layers at the top of the support, right under the part, here 3.',
  'still-support-interface-spacing': 'The gap between the interface lines under the part, here 0.5 mm. Smaller gives a smoother underside.',
  'still-support-style': 'The same overhang held up by grid, snug, organic and tree slim support, left to right.',
  'still-one-wall-top': 'The same top with 3 walls and with 1. With one wall the top lines reach almost to the edge.',
  'still-one-wall-first': 'The first layer with 3 walls and with 1. With one wall the bottom lines reach almost to the edge.',
  'still-ironing-angle': 'With a fixed angle, ironing runs at that angle, here 0°, instead of along the top lines.',
  'still-paint-depth-top': 'A painted top colors this many layers down from the top surface, here 3.',
  'still-paint-depth-bottom': 'A painted bottom colors this many layers up from the bottom surface, here 3.',
  'still-line-width-support': 'The support lines, picked out under a ledge, print at the default width when this is 0, here 0.42 mm.',
  'still-line-width-bridge': 'The bridge lines over the gap, seen end on, print 0.40 mm wide, 100% of a 0.4 mm nozzle.',
  'still-model-tree': 'Each entry in the tree is one thing in the view: a sketch lies on its plane, a body stands on the plate.',
  'still-timeline': 'Steps run left to right. Move the marker back and the part shows as it was there; the steps after it are grayed.',
  'still-pick-object': 'Picking objects takes the whole part.',
  'still-pick-face': 'Picking faces takes one face of the part.',
  'still-pick-edge': 'Picking edges takes one edge, where two faces meet.',
  'still-sketch-status': 'Constraint glyphs sit by the lines they hold. The status line says how much of the sketch can still move.',
  'still-named-values': 'Name a value once, type its name in a size such as a push and pull distance, and the part follows when the value changes.',
  'still-hollow': 'Hollowing empties the inside and leaves an even wall all around, here 2 mm, which saves material and print time.',
  'still-repair': 'Repair closes open edges and turns flipped faces to point outward, so the mesh slices as a closed solid.',
  'still-measure': 'Pick two places: the panel gives the distance between them and how far apart they are along X, Y and Z.',
} as const
/** Setting keys and the still their row shows, as rowsPlay rows. */
const stills = (rows: readonly (readonly [key: string, still: keyof typeof STILL_TIPS])[]) => rows.map(([key, still]) => [key, null, STILL_TIPS[still]] as const)

test('Slice rows from line width to skirt distance show their own stills', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await rowsPlay(page, stills([['line_width', 'still-line-width'], ['outer_wall_line_width', 'still-line-width-outer'], ['inner_wall_line_width', 'still-line-width-inner'], ['top_surface_line_width', 'still-line-width-top'], ['sparse_infill_line_width', 'still-line-width-sparse'], ['internal_solid_infill_line_width', 'still-line-width-solid'], ['initial_layer_line_width', 'still-line-width-first'], ['top_shell_layers', 'still-shells-top'], ['top_shell_thickness', 'still-shells-top'], ['bottom_shell_layers', 'still-shells-bottom'], ['bottom_shell_thickness', 'still-shells-bottom'], ['initial_layer_print_height', 'still-first-layer-height'], ['top_surface_pattern', 'still-surface-pattern-top'], ['bottom_surface_pattern', 'still-surface-pattern-bottom'], ['sparse_infill_pattern', 'still-sparse-pattern'], ['skirt_distance', 'still-skirt-distance']]))
})

test('Slice rows from skirt loops to painted depth show their own stills, and interlocking beam plays its loop', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await rowsPlay(page, [...stills([['skirt_loops', 'still-skirt-loops'], ['min_skirt_length', 'still-skirt-length'], ['brim_object_gap', 'still-brim-gap'], ['raft_layers', 'still-raft-layers'], ['support_top_z_distance', 'still-support-top-gap'], ['support_bottom_z_distance', 'still-support-bottom-gap'], ['support_object_xy_distance', 'still-support-xy-gap'], ['support_interface_top_layers', 'still-support-interface-layers'], ['support_interface_spacing', 'still-support-interface-spacing'], ['support_style', 'still-support-style'], ['only_one_wall_top', 'still-one-wall-top'], ['only_one_wall_first_layer', 'still-one-wall-first'], ['ironing_angle', 'still-ironing-angle'], ['ironing_angle_fixed', 'still-ironing-angle'], ['top_color_penetration_layers', 'still-paint-depth-top'], ['bottom_color_penetration_layers', 'still-paint-depth-bottom']]), ['interlocking_beam', 'ail']])
})

test('Support and bridge line width rows show their own stills', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Hover tips need a mouse')
  await rowsPlay(page, stills([['support_line_width', 'still-line-width-support'], ['bridge_line_width', 'still-line-width-bridge']]))
})

test('Model controls show their stills: the tree, the picks, measure, named values, hollow, repair, the timeline marker and the sketch status', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Modeling tools are desktop only')
  test.setTimeout(120_000)
  await openStudio(page)
  const id = await freshBox(page)
  const tip = page.locator('#sx-tip')
  const stage = tip.locator('.sx-stage')
  const shows = async (anchor: Locator, still: keyof typeof STILL_TIPS) => {
    await anchor.hover()
    await expect(stage.locator('svg.sxs'), still).toBeVisible()
    await expect(stage, still).toHaveAttribute('aria-label', STILL_TIPS[still])
    await page.mouse.move(5, 5)
    await expect(tip).toHaveCount(0)
  }
  // the status line under an open sketch
  await command(page, 'Sketch on the bed or a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('the bed or a flat face to sketch on')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(panel).toContainText('A face of')
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
  await sketchAt(page, 'click', [2, 1])
  await sketchAt(page, 'click', [6, 1])
  await shows(panel.getByTestId('sketch-dof'), 'still-sketch-status')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  // Hollow and Repair mesh need a selection
  await page.evaluate((id) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ selection: id, selectedIds: [id] }), id)
  await page.locator('.sx-tab[data-mode="design"]').click()
  await shows(page.locator('.dtree-folder-name', { hasText: 'Bodies' }), 'still-model-tree')
  for (const k of ['object', 'face', 'edge'] as const) await shows(page.locator(`[data-testid="model-select-filter"][data-kind="${k}"]`), `still-pick-${k}`)
  await shows(page.locator('[data-testid="model-shelf-tool"][data-tool="measure"]'), 'still-measure')
  await shows(page.locator('[data-testid="model-shelf-tool"][data-tool="values"]'), 'still-named-values')
  // Hollow and Repair mesh sit on the ribbon's Mesh tab
  await page.getByTestId('ribbon-tab-mesh').click()
  for (const [tool, still] of [['hollow', 'still-hollow'], ['repair', 'still-repair']] as const) {
    await shows(page.locator(`[data-testid="model-shelf-tool"][data-tool="${tool}"]`), still)
  }
  // the timeline marker, once there is a step to roll back
  await pushTop(page, id, 5)
  await page.getByRole('button', { name: 'Open Timeline' }).click()
  await shows(page.getByTestId('tl-marker'), 'still-timeline')
})
