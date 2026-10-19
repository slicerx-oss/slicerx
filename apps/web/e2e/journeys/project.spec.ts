// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Projects another slicer wrote and the person's own, opened on the person's A1 mini, on one page: Bambu Studio's -1
// values, a project's import report, a project with its own start G-code, a cosmetic stock script, a P1S 0.2 project that opens as its own
// printer, the saved .sx3mf and its metadata, and the CAD-only build's real STL download. Each project is made here (projectZip). Each step starts over
// with the example plate on the A1 mini and opens its own project.
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { command } from '../cad-helpers'
import { expectFileDialog } from '../file-dialog'
import { addMenu, expect, sliceCount, sliced, tab } from '../fixtures'
import { journey as test } from '../journey'
import { cubeModel, projectZip, zip } from '../project-zip'
import { examplePlate, openModel, setFlags, setState, useFileDialogs, useFlags } from './lib/model'

const A1_MINI = { id: 'e2e-a1-mini', name: 'Desk A1 mini', profileId: 'bambu-a1-mini', vendor: 'Bambu Lab', model: 'A1 mini', nozzleCount: 1 }

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, handPrinters: [A1_MINI], printerId: A1_MINI.id } })
test.skip(({ isMobile }) => isMobile, 'Runs at desktop width')
useFlags()
useFileDialogs()

/**
 * The example plate on the person's A1 mini. Saves go through a plain download, not the browser's save picker, and every
 * toast's text is kept as it is drawn: a note without a button is on screen for 2.6 s, and a busy runner can take longer
 * than that between the click that posts it and the first look.
 */
async function fresh(page: Page): Promise<void> {
  await page.evaluate(() => {
    Reflect.deleteProperty(window, 'showSaveFilePicker')
    const w = window as unknown as { __toasts?: string[] }
    if (w.__toasts) return
    const seen: string[] = []
    w.__toasts = seen
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[data-testid="toast"]')) if (el.textContent && !seen.includes(el.textContent)) seen.push(el.textContent)
    }).observe(document, { childList: true, subtree: true, characterData: true })
  })
  await examplePlate(page)
  await setState(page, { printerId: A1_MINI.id })
  await expect(page.locator('[data-section="printer"] .printer-name')).toContainText('A1 mini')
}

/** The text of the toast that has `has` in it, from every toast drawn so far, gone or not. */
async function toastWith(page: Page, has: string): Promise<string | undefined> {
  return (await page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts)).find((t) => t.includes(has))
}

/** Open (Mod+O) a project made here: a new project with the file, so its settings come along. */
async function openProject(page: Page, name: string, settings: Record<string, unknown>, at?: [number, number]): Promise<void> {
  await openModel(page, { name, mimeType: 'model/3mf', buffer: projectZip(settings, {}, at) })
  await expect(page.locator('.obj-name')).toHaveText(['Cube'], { timeout: 60_000 })
}

// ---------------------------------------------------------------------------------------------------------------------
// Bambu Studio's -1 values and the import report
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A Bambu Studio project carries -1 where Bambu Studio picks the value itself (raft_first_layer_expansion,
 * tree_support_wall_count). It opens and slices with the real engine, and a value the engine still refuses is dropped
 * with a note instead of blocking the slice.
 */
test.describe('a Bambu Studio project', () => {
  /** Bambu Studio's -1s as it writes them (every value a string), with a raft and supports on so they are used. */
  const BAMBU = {
    enable_support: '1',
    raft_layers: '2',
    raft_first_layer_expansion: '-1',
    tree_support_wall_count: '-1',
    support_interface_bottom_layers: '-1',
    prime_tower_brim_width: '-1',
    ironing_fan_speed: ['-1'],
    filament_ramming_volumetric_speed: ['-1'],
    filament_tower_interface_print_temp: ['-1'],
  }

  async function sliceToDone(page: Page): Promise<void> {
    const before = await sliceCount(page)
    await page.getByRole('button', { name: 'Slice plate' }).click()
    await expect(sliced(page, before)).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText(/config key/)).toHaveCount(0)
  }

  test("a Bambu Studio project's -1 values open and slice with no error", async ({ page }) => {
    test.slow()
    await fresh(page)
    await openProject(page, 'a1-mini.3mf', BAMBU)
    await sliceToDone(page)
  })

  test('a project value the engine refuses is dropped with a note, and the plate still slices', async ({ page }) => {
    test.slow()
    await fresh(page)
    await openProject(page, 'a1-mini.3mf', { ...BAMBU, raft_expansion: '-3' })
    const before = await sliceCount(page)
    await page.getByRole('button', { name: 'Slice plate' }).click()
    await expect(page.getByText(/Setting not imported from a1-mini\.3mf: Raft expansion/)).toBeVisible({ timeout: 120_000 })
    await expect(sliced(page, before)).toBeVisible({ timeout: 120_000 })
    await expect(page.getByText(/config key/)).toHaveCount(0)
  })

  /** A Bambu Studio project that inherited its walls, with a setting SlicerX does not have. */
  const INHERITED = {
    layer_height: '0.2',
    wall_generator: 'classic',
    top_one_wall_type: 'all top',
    different_settings_to_system: ['layer_height', '', ''],
  }

  test("an opened project's import report shows in Settings > Presets", async ({ page }) => {
    await fresh(page)
    await openProject(page, 'a1-mini.3mf', INHERITED)
    try {
      // The note's first sentence shows; Details opens the rest in place.
      const note = page.getByTestId('toast').filter({ hasText: /Settings > Presets lists the 1 setting it did not carry over/ })
      await note.getByTestId('toast-details').click({ timeout: 30_000 })
      await expect(note.getByText(/Settings > Presets lists the 1 setting it did not carry over/)).toBeVisible()
      await setState(page, { settingsOpen: true, settingsSection: 'presets' })
      const report = page.locator('.imp-report').filter({ hasText: 'Opened a1-mini.3mf' })
      await expect(report.locator('.imp-sum')).toHaveText(/Opened a1-mini\.3mf: 1 setting did not carry over/)
      await expect(report.locator('.imp-count')).toHaveText(/Project settings, 1 setting did not carry over/)
      await report.locator('summary').click()
      await expect(report.getByText("Walls: aegis walls, kept by SlicerX; the project used its preset's default classic.")).toBeVisible()
    } finally {
      await setState(page, { settingsOpen: false })
    }
  })

  test('a project whose settings file is not JSON opens, with a note that its settings were left out', async ({ page }) => {
    await fresh(page)
    const buffer = zip({ '3D/3dmodel.model': cubeModel(), 'Metadata/project_settings.config': '; an older export\nlayer_height = 0.3\nnozzle_diameter = 0.4\n' })
    await openModel(page, { name: 'older.3mf', mimeType: 'model/3mf', buffer })
    await expect(page.locator('.obj-name')).toHaveText(['Cube'], { timeout: 60_000 })
    await expect
      .poll(() => toastWith(page, 'print settings were left out'), { timeout: 30_000 })
      .toContain('Its print settings were left out because they are in an older key = value format, so it opens with the current settings.')
  })

  // Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
  test("shots: an opened project's import report, light and dark", async ({ page }, info) => {
    test.skip(!process.env['SX_SHOTS'], 'SX_SHOTS=1 only')
    test.slow()
    const dir = process.env['SX_SHOTS_DIR'] ?? info.outputPath('shots')
    const width = page.viewportSize()?.width ?? 0
    const was = await page.evaluate(() => { const s = (window as unknown as { __sx: { getState(): { scheme: string; themeFollowsSystem: boolean } } }).__sx.getState(); return { scheme: s.scheme, themeFollowsSystem: s.themeFollowsSystem } })
    await fresh(page)
    await openProject(page, 'a1-mini.3mf', INHERITED)
    await setState(page, { settingsOpen: true, settingsSection: 'presets' })
    const report = page.locator('.imp-report').filter({ hasText: 'Opened a1-mini.3mf' })
    await report.locator('summary').click()
    for (const scheme of ['light', 'dark'] as const) {
      await setState(page, { scheme, themeFollowsSystem: false })
      await report.scrollIntoViewIfNeeded()
      await page.mouse.move(0, 0)
      await page.waitForTimeout(400)
      await page.locator('.settings-dialog').screenshot({ path: `${dir}/project-import-report-${scheme}-${width}.png` })
    }
    await setState(page, { ...was, settingsOpen: false })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// A project's own G-code
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A SlicerX project with its own start G-code, opened on the person's A1 mini: the slice they start asks first, in one
 * plain line, with what the project changes folded under Show differences until they open it. The printer's G-code is
 * the default. The project is made here: a cube and a start G-code with an M500 in it.
 */
test.describe("a project's own G-code", () => {
  const START = 'G28\nM500 ; keep my offsets\nG1 Z5 F3000\n'

  /**
   * Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default). The dialog at 1440 and
   * 390 px wide, dark and light; the viewport and theme are put back after.
   */
  async function shots(page: Page, name: string): Promise<void> {
    if (!process.env['SX_SHOTS']) return
    const dir = process.env['SX_SHOTS_DIR'] ?? test.info().outputPath('shots')
    const before = page.viewportSize()
    type Theme = { __sx: { getState(): { scheme: string; themeFollowsSystem: boolean }; setState(p: unknown): void } }
    const theme = await page.evaluate(() => {
      const st = (window as unknown as Theme).__sx.getState()
      return { scheme: st.scheme, themeFollowsSystem: st.themeFollowsSystem }
    })
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height })
      for (const scheme of ['dark', 'light'] as const) {
        await page.evaluate((s) => (window as unknown as Theme).__sx.setState({ scheme: s, themeFollowsSystem: false }), scheme)
        await page.mouse.move(0, 0)
        await page.waitForTimeout(400)
        await page.screenshot({ path: `${dir}/project-gcode-${name}-${scheme}-${width}.png` })
      }
    }
    if (before) await page.setViewportSize(before)
    await page.evaluate((t) => (window as unknown as Theme).__sx.setState(t), theme)
  }

  test('a cosmetic stock script keeps its text and slices without person approval', async ({ page }) => {
    try {
      const text = '  M400 U1 ; pause\r\n'
      await fresh(page)
      await openProject(page, 'bracket.sx3mf', { printer_model: 'Bambu Lab A1 mini', gcode_flavor: 'marlin', machine_pause_gcode: text }, [90, 90])
      const read = () => page.evaluate(() => {
        const state = (window as unknown as { __sx: { getState(): {
          overrides: Record<string, unknown>; vouchedGcode: Record<string, unknown>;
          projectScriptReviews: { records: { review: { decision: string } }[] } | null;
        } } }).__sx.getState()
        return { text: state.overrides.machine_pause_gcode, vouched: state.vouchedGcode.machine_pause_gcode, decision: state.projectScriptReviews?.records[0]?.review.decision }
      })
      await expect.poll(read).toEqual({ text, vouched: undefined, decision: 'cosmetic' })
      const before = await sliceCount(page)
      await page.getByRole('button', { name: 'Slice plate' }).click()
      await expect(sliced(page, before)).toBeVisible({ timeout: 120_000 })
      await expect(page.getByTestId('project-gcode-dialog')).toBeHidden()
      expect(await read()).toEqual({ text, vouched: undefined, decision: 'cosmetic' })
    } finally {
      // The project's script stays among the person's own settings after a new project; the tests after this one start without it.
      await setState(page, { overrides: {}, vouchedGcode: {} })
    }
  })

  test("a project's own G-code asks in one line, with the differences folded until opened", async ({ page }) => {
    test.slow()
    await fresh(page)
    await openProject(page, 'bracket.sx3mf', { machine_start_gcode: START }, [90, 90])
    const before = await sliceCount(page)
    await page.getByRole('button', { name: 'Slice plate' }).click()
    const dialog = page.getByTestId('project-gcode-dialog')
    await expect(dialog).toBeVisible({ timeout: 60_000 })
    await expect(dialog.getByRole('heading', { level: 2 })).toHaveText("This project's G-code doesn't match your printer")
    await expect(dialog.locator('.pg-lede')).toHaveText("bracket.sx3mf has its own printer G-code, different from the Bambu Lab A1 mini profile's.")
    await expect(page.getByTestId('project-gcode-use-profile')).toHaveText("Use the printer's G-code")
    await expect(page.getByTestId('project-gcode-use-profile')).toBeFocused()
    await expect(page.getByTestId('project-gcode-use-project')).toHaveText("Use the project's G-code")
    await expect(page.getByTestId('project-gcode-use-project')).toBeEnabled()
    // Folded by default: no per-script counts, flagged lines or diff rows until the person asks.
    const toggle = dialog.getByRole('button', { name: 'Show differences' })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(dialog.locator('.pg-change')).toHaveCount(0)
    await expect(dialog).not.toContainText('lines added')
    await shots(page, 'collapsed')
    const at = await toggle.boundingBox()
    await toggle.click()
    const hide = dialog.getByRole('button', { name: 'Hide differences' })
    await expect(hide).toHaveAttribute('aria-expanded', 'true')
    const start = dialog.getByRole('region', { name: 'Hide differences' }).locator('.pg-change', { hasText: 'Start G-code' })
    await expect(start).toBeVisible()
    await expect(start.locator('.pg-flags')).toContainText("M500 writes settings to the printer's memory")
    await expect(start.locator('.pg-row[data-kind="added"]', { hasText: 'M500 ; keep my offsets' })).toBeVisible()
    // The control stays where it was when the list opens below it.
    expect((await hide.boundingBox())?.y).toBe(at?.y)
    await shots(page, 'expanded')
    await page.getByTestId('project-gcode-use-profile').click()
    await expect(dialog).toBeHidden()
    await expect(sliced(page, before)).toBeVisible({ timeout: 120_000 })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// A project that brings its own printer
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A Bambu Studio P1S 0.2 project opens as its own printer, as Bambu Studio opens it: no question on an empty plate, the
 * P1S 0.2 profile, and the project's own start G-code in the slice. Moving the plate to the person's A1 mini takes the
 * A1 mini's G-code (none of the project's M290 or M500) and says which settings stayed behind. Added to a plate that
 * has objects, the project asks first. The project is made here: a 20 mm cube and Bambu Studio's settings form.
 */
test.describe('a project with its own printer', () => {
  const START = 'G28\nM290 Z0.02 ; baby step from the project\nM500\nG1 Z5 F3000\n'
  const P1S = {
    printer_settings_id: 'Bambu Lab P1S 0.2 nozzle',
    printer_model: 'Bambu Lab P1S',
    printer_variant: '0.2',
    nozzle_diameter: ['0.2'],
    layer_height: '0.08',
    wall_loops: '3',
    different_settings_to_system: ['layer_height;wall_loops', '', ''],
    machine_start_gcode: START,
  }

  async function sliceAndExport(page: Page): Promise<string> {
    const before = await sliceCount(page)
    await page.getByRole('button', { name: 'Slice plate' }).click()
    await expect(sliced(page, before)).toBeVisible({ timeout: 120_000 })
    const [download] = await Promise.all([page.waitForEvent('download'), command(page, 'Export G-code')])
    return readFileSync(await download.path(), 'utf8')
  }

  test('a P1S 0.2 project opens as its own printer, and the A1 mini slices it with its own G-code', async ({ page }) => {
    test.slow()
    await fresh(page)
    const chooser = await expectFileDialog(page, () => page.keyboard.press('ControlOrMeta+o'))
    await chooser.setFiles({ name: 'keychain.3mf', mimeType: 'model/3mf', buffer: projectZip(P1S, {}, [118, 118]) })
    await expect(page.locator('.obj-name')).toHaveText(['Cube'], { timeout: 60_000 })
    // Toasts stack; the note is the one that names the printer.
    await expect(page.getByTestId('toast').filter({ hasText: 'Opened as P1S' })).toContainText('Opened as P1S 0.2 mm from the project.')
    // The button names the printer; the project it came from is in the tooltip.
    await expect(page.locator('[data-section="printer"] .printer-name')).toHaveText('P1S 0.2')
    await expect(page.getByTestId('slice-machine-printer')).toHaveAttribute('data-tip-body', /^P1S 0\.2 from keychain\.3mf\. /)
    await expect(page.getByTestId('project-gcode-dialog')).toHaveCount(0)
    const own = await sliceAndExport(page)
    expect(own).toContain('M290 Z0.02 ; baby step from the project')
    expect(own).toMatch(/^; layer_height = 0\.08$/m)
    // The person's A1 mini, from the note's Change printer.
    await tab(page, 'prepare').click()
    const list = page.getByRole('list', { name: 'Choose a printer' })
    if (!(await list.isVisible())) await page.getByTestId('slice-machine-printer').click()
    await list.getByRole('button', { name: /Desk A1 mini/ }).click()
    await expect.poll(() => toastWith(page, 'Slicing for the A1 mini')).toBe("Slicing for the A1 mini with its own G-code. Not carried over, made for the project's 0.2 mm nozzle: layer height.")
    const theirs = await sliceAndExport(page)
    expect(theirs).not.toContain('baby step from the project')
    expect(theirs).not.toMatch(/^M500/m)
    expect(theirs).not.toMatch(/^; layer_height = 0\.08$/m)
    expect(theirs).toMatch(/^; wall_loops = 3$/m)
  })

  test('a project added to a plate with objects asks, and geometry only keeps the printer', async ({ page }) => {
    test.slow()
    await fresh(page)
    const chooser = await expectFileDialog(page, () => page.getByTestId('objects-add-model').click())
    await chooser.setFiles({ name: 'keychain.3mf', mimeType: 'model/3mf', buffer: projectZip(P1S, {}, [118, 118]) })
    const dialog = page.getByTestId('project-open-dialog')
    await expect(dialog).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('project-open-as-project')).toBeVisible()
    await page.getByTestId('project-open-geometry-only').click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('.obj-name')).toHaveText(['Layered X', 'Cube'], { timeout: 60_000 })
    await expect(page.locator('[data-section="printer"] .printer-name')).toContainText('A1 mini')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Saving the project
// ---------------------------------------------------------------------------------------------------------------------

test('save the project as .sx3mf with the SlicerX metadata', async ({ page }) => {
  // `fresh` takes the save picker away: headless Chromium has no save dialog, so the host falls back to a download.
  await fresh(page)
  await addMenu(page, 'Export')
  await expect(page.getByRole('menuitem', { name: /STL/ })).toHaveCount(0)
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Save project/ }).click()])
  expect(download.suggestedFilename()).toMatch(/\.sx3mf$/)
  const bytes = readFileSync(await download.path())
  expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304')
  // Entries are deflated; read them back through their local headers.
  const { inflateRawSync } = await import('node:zlib')
  const entries = new Map<string, string>()
  for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50; ) {
    const method = bytes.readUInt16LE(at + 8)
    const size = bytes.readUInt32LE(at + 18)
    const nameLen = bytes.readUInt16LE(at + 26)
    const start = at + 30 + nameLen + bytes.readUInt16LE(at + 28)
    const raw = bytes.subarray(start, start + size)
    entries.set(bytes.subarray(at + 30, at + 30 + nameLen).toString(), (method === 8 ? inflateRawSync(raw) : raw).toString())
    at = start + size
  }
  expect(entries.get('3D/3dmodel.model')).toContain('sx:ExportedBy')
  expect([...entries.keys()]).toContain('Metadata/model_settings.config')
})

// ---------------------------------------------------------------------------------------------------------------------
// The CAD-only build
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The CAD-only browser build (web_slicing off) turns a test build into that host with slicerx.e2e.cadOnly, read once
 * as the host starts. What it shows without slicing is tested in packages/app/test/cad-only-web.test.ts:32/54/90 and
 * cad-only-mode.test.ts:72; this is the real download.
 */
test('the CAD-only build exports a real STL from its Export menu', async ({ page }) => {
  await setFlags(page, { 'slicerx.e2e.cadOnly': '1' })
  try {
    // saves go through a plain download, not the browser's save picker
    await page.evaluate(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
    await setState(page, { plate: [], selection: null, selectedIds: [] })
    await command(page, 'Add a box')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate.length)).toBe(1)
    await page.getByTestId('model-export').click()
    const menu = page.getByRole('menu', { name: 'Export' })
    await expect(menu).toBeVisible()
    for (const name of ['Whole model as STL', 'Whole model as OBJ', 'Project file (.sx3mf)']) await expect(menu.getByRole('menuitem', { name })).toBeEnabled()
    const [download] = await Promise.all([page.waitForEvent('download'), menu.getByRole('menuitem', { name: 'Whole model as STL' }).click()])
    expect(download.suggestedFilename()).toMatch(/\.stl$/)
  } finally {
    await setFlags(page, { 'slicerx.e2e.cadOnly': null })
  }
})
