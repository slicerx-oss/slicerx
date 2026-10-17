// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app link journey: clients reach the open app through a real sx-link, and the person allows them in the app.
// One hub and one paired page serve the whole file (lib/links.ts), so a test only makes its client and answers its
// grant. The methods themselves are unit tested (packages/app/test/app-link-*.test.ts, packages/mcp/test/app-*.test.ts),
// so each test here keeps what only a real hub, a real page and a real engine show: the grant, the wiring, what the
// window draws, and one representative call. What each test leaves out is named in a comment where it was cut.
// Runs only when SX_LINK_BIN names a built sx-link.
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { TopologyManifest } from '../../../../packages/cad-history/src/topology-manifest'
import { bounds, command } from '../cad-helpers'
import { expectFileDialog } from '../file-dialog'
import { plateReady, sliceCount, sliced, tab, viewSized, viewportReady } from '../fixtures'
import { SMALL_3, plateProject } from '../plate-project'
import { cleanPlate, codeOnlyCli, expect, linkMissing, linkPrefs, mcpDir, mcpRequire, scratch, session, sx, test, windowsCli, type Answer } from './lib/links'

test.use({ journeyPrefs: linkPrefs })
test.skip(linkMissing, 'SX_LINK_BIN is not set')
test.skip(({ isMobile }) => isMobile, 'The app link is hosted by the desktop shell')

const refused = { isError: true, structuredContent: { error: { code: 'not_supported' } } }
const slab = { shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 8 }

test('a read-only grant reads and is refused every edit, an edit grant works, and a client with only a hub code is told how to connect', async ({ page, link }) => {
  test.slow()
  await cleanPlate(page)
  await scratch('grants', async (dir) => {
    const editor = await session(link, page, dir, 'grant-editor', 'edit')
    const reader = await session(link, page, dir, 'grant-reader', 'read')
    try {
      const design = (await editor.ok('design_new', { name: 'Grant block' })).design
      await editor.ok('geom_extrude', { design, ...slab })
      // Read: the project's history, values and volumes, and a body's geometry.
      const history = await reader.ok('app_history')
      expect(await reader.ok('app_values')).toMatchObject({ values: [] })
      expect(await reader.ok('app_volumes', { object: design })).toMatchObject({ volumes: [] })
      expect(await reader.call('geom_info', { design })).toMatchObject({ structuredContent: { output: { in: 'app', parts: [{ watertight: true, volumeMm3: expect.closeTo(1600, 4) }] } } })
      // Edit: one command of each family is refused for the reader. Each family's own methods are checked in
      // app-link-history.test.ts:74, app-link-values.test.ts:103, app-link-volumes.test.ts:155 and app-link-modeling.test.ts:71.
      for (const [tool, args] of [
        ['app_undo', { revision: history.revision }],
        ['app_redo', { revision: history.revision }],
        ['app_value_set', { name: 'height', expression: '3' }],
        ['app_volume_add', { object: design, role: 'negative', shape: 'box' }],
        ['geom_shell', { design, open: [{ at: [0, 0, 8], normal: [0, 0, 1] }], wall_mm: 1 }],
        ['geom_cut', { design, plane: { axis: 'z', at: 4 }, keep: 'both' }],
      ] as const) expect(await reader.call(tool, args), tool).toMatchObject(refused)
    } finally {
      await reader.close()
      await editor.close()
    }

    // A hub code authenticates the CLI to the hub, but does not register a client the app can grant: no prompt, and
    // the answer says how to connect (the message itself is app-plates.test.ts:54 and app-assistant.test.ts:74).
    for (const tool of ['app_plates', 'app_look']) {
      const { code, rows } = await codeOnlyCli(link, dir, tool)
      expect(code, tool).toBe(1)
      expect(rows, tool).toHaveLength(1)
      expect(rows[0]!.ok, tool).toBe(false)
      expect(rows[0]!.output.error).toMatchObject({ code: 'not_configured', details: { appLink: 'unauthorized' } })
      expect(rows[0]!.output.error.message).toContain('A hub pairing code alone does not open a permission prompt')
    }
    await expect(page.getByTestId('app-link-read')).toBeHidden()
    await expect(page.getByTestId('app-link-allow')).toBeHidden()
  })
})

test('a client reads and sets Toolbar size and reads the 3D view look, over MCP and the command line, each read back', async ({ page, link }) => {
  test.slow()
  await cleanPlate(page, 'design')
  const ribbon = page.getByTestId('model-shelf')
  const agent = await link.agent()
  const was = await sx.get(page, 'scheme')
  const followed = await sx.get(page, 'themeFollowsSystem')
  const setScheme = (scheme: string) => sx.set(page, { scheme, themeFollowsSystem: false })
  try {
    // The first call is the grant. The defaults and every bad value are app-link-look.test.ts:28/39 and
    // app-look.test.ts:57, and Frame the view is read and set the same way, so Toolbar size stands for both.
    await agent.call('app_look_set', { toolbarSize: 'large', modelFraming: 'selection' })
    await expect(ribbon).toHaveAttribute('data-setting', 'large')
    expect(await agent.call('app_look_set', { toolbarSize: 'small' })).toMatchObject({ toolbarSize: 'small', modelFraming: 'selection' })
    await expect(ribbon).toHaveAttribute('data-setting', 'small')
    expect((await agent.raw('app_look_set', { toolbarSize: 'huge' })).isError).toBe(true)
    await expect(ribbon).toHaveAttribute('data-setting', 'small')

    // The 3D view's look reads back with the preset the theme picked, and follows a scheme change.
    await setScheme('dark')
    await expect.poll(async () => (await agent.call('app_look')).viewport?.preset).toBe('dark-precision')
    expect((await agent.call('app_look')).viewport).toMatchObject({ themeBackdrop: false, look: { backdrop: { top: '#2a2e3a' } } })
    await setScheme('light')
    await expect.poll(async () => (await agent.call('app_look')).viewport?.preset).toBe('light-studio')
    expect((await agent.call('app_look')).viewport?.look.backdrop.top).toBe('#e3e6ea')

    // The person changes Toolbar size in Settings; the client reads it back.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Look and feel' }).click()
    await dialog.getByTestId('set-toolbar-size').getByRole('radio', { name: 'Medium' }).click()
    await expect(ribbon).toHaveAttribute('data-setting', 'medium')
    expect(await agent.call('app_look')).toMatchObject({ toolbarSize: 'medium' })
    await page.keyboard.press('Escape')

    // The command line: slicerx-mcp call, one JSON line per call, the change and its read-back.
    const lines = await agent.cli('app_look_set', { toolbarSize: 'large', modelFraming: 'selection' }, 'app_look')
    expect(lines.map((l) => l.ok)).toEqual([true, true])
    expect(lines[0]!.output.output).toMatchObject({ toolbarSize: 'large', modelFraming: 'selection' })
    expect(lines[1]!.output.output).toMatchObject({ toolbarSize: 'large', modelFraming: 'selection' })
    await expect(ribbon).toHaveAttribute('data-setting', 'large')
  } finally {
    await setScheme(was)
    await sx.set(page, { themeFollowsSystem: followed })
  }
})

// Both public client paths read the live renderer, including notices emitted before any client reads them.
// The route and its refusals are app-viewport.test.ts:9/18/25.
test('a client reads viewport telemetry over MCP and the CLI without changing the view', async ({ page, link }) => {
  await cleanPlate(page)
  await viewportReady(page)
  type Telemetry = { pixelRatio: number; motionScale: number; motionFull: boolean; degrade: { count: number; lastAt: string | null }; drawnPlate: number | null }
  const agent = await link.agent()
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __vp?: unknown }).__vp))).toBe(true)
  const read = async (): Promise<Telemetry> => (await agent.call('app_viewport')).viewport
  const first = await read()
  expect(first.pixelRatio).toBeGreaterThan(0)
  expect(first.motionScale).toBeGreaterThan(0)
  expect(typeof first.motionFull).toBe('boolean')
  expect(first.drawnPlate).toBe(1)
  const emitted = await page.evaluate(() => {
    const vp = (window as unknown as { __vp: { emit(name: string, event: { message: string }): void; stats(): Omit<Telemetry, 'drawnPlate'>; resetStats(): void } }).__vp
    vp.emit('degrade', { message: 'Viewport telemetry test notice.' })
    vp.resetStats()
    const { pixelRatio, motionScale, motionFull, degrade } = vp.stats()
    return { pixelRatio, motionScale, motionFull, degrade }
  })
  expect(emitted.degrade.count).toBe(first.degrade.count + 1)
  expect(emitted.degrade.lastAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(await read()).toMatchObject(emitted)
  const lines = await agent.cli('app_viewport', 'app_viewport')
  expect(lines).toHaveLength(2)
  for (const line of lines) {
    expect(line.ok, JSON.stringify(line)).toBe(true)
    expect(line.output.output.viewport).toMatchObject({ ...emitted, drawnPlate: 1 })
  }
})

test('a client lists the plates and steps through them over MCP and the command line, each read back', async ({ page, link }) => {
  test.slow()
  await cleanPlate(page)
  const agent = await link.agent()
  const shownInApp = page.getByTestId('plate-picker-current').locator('.pp-no')
  try {
    const chooser = await expectFileDialog(page, () => page.keyboard.press('ControlOrMeta+o'))
    await chooser.setFiles({ name: 'Deck box.3mf', mimeType: 'model/3mf', buffer: plateProject(SMALL_3) })
    await expect(page.getByTestId('plate-picker-current').locator('.pp-of')).toHaveText('of 3', { timeout: 60_000 })
    await viewSized(page)

    const listed = await agent.call('app_plates')
    // The view draws the plate shown: plate 1 after the open, not the last plate it loaded.
    expect(listed).toMatchObject({ shown: 1, drawn: 1, count: 3 })
    expect(listed.plates.map((p: { name: string }) => p.name)).toEqual(SMALL_3)

    // A step, read back, and the picker on screen shows the same plate. The summaries are app-plates.test.ts:24.
    expect(await agent.call('app_plate_show', { step: 'next' })).toMatchObject({ shown: 2, drawn: 2, plates: [{ shown: false }, { shown: true }, { shown: false }] })
    await expect(shownInApp).toHaveText('Plate 2')
    expect(await agent.call('app_plate_show', { plate: 3 })).toMatchObject({ shown: 3, drawn: 3 })
    await expect(shownInApp).toHaveText('Plate 3')
    await expect(page.getByTestId('plate-picker-next')).toBeDisabled()
    // Past the last plate: refused, and nothing moves. No unit test reaches this refusal (methods.ts plates.show).
    const end = await agent.raw('app_plate_show', { step: 'next' })
    expect(end.isError).toBe(true)
    expect(JSON.stringify(end.content)).toContain('last plate')
    await expect(shownInApp).toHaveText('Plate 3')

    // The person steps back with Shift+[; the client reads it back.
    await page.locator('canvas.vp-canvas').focus()
    await page.keyboard.press('Shift+BracketLeft')
    await expect(shownInApp).toHaveText('Plate 2')
    expect(await agent.call('app_plates')).toMatchObject({ shown: 2, drawn: 2 })

    // The command line: slicerx-mcp call, one JSON line per call, the step and its read-back.
    const lines = await agent.cli('app_plate_show', { step: 'previous' }, 'app_plates')
    expect(lines.map((l) => l.ok)).toEqual([true, true])
    expect(lines[0]!.output.output).toMatchObject({ shown: 1 })
    expect(lines[1]!.output.output).toMatchObject({ shown: 1, drawn: 1, count: 3 })
    await expect(shownInApp).toHaveText('Plate 1')
  } finally {
    await cleanPlate(page)
  }
})

test('a client reads the open Push and pull and types a distance for the person over MCP and the command line', async ({ page, link }) => {
  test.slow()
  await cleanPlate(page, 'design')
  // a fresh box in Model, its top face picked, then Push and pull
  await command(page, 'Add a box')
  await expect.poll(async () => (await sx.get(page, 'plate')).length).toBe(1)
  const id: string = await page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: { id: string }[] } } }).__sx.getState().plate[0]!.id)
  await expect.poll(() => page.evaluate((id) => (window as unknown as { __vp: { drawnObjects(): string[] } }).__vp.drawnObjects().includes(id), id)).toBe(true)
  await page.evaluate(() => (window as unknown as { __vp: { view(v: string, o?: unknown): void } }).__vp.view('fit', { animate: false }))
  const height = async () => {
    const b = await bounds(page, id)
    return Math.round((b.max[2] - b.min[2]) * 100) / 100
  }
  const h0 = await height()
  const agent = await link.agent()
  const distance = page.getByTestId('push-view-distance')

  // Push and pull is shut, and typing a distance into it is refused. The first call is the grant.
  expect(await agent.call('app_model_push')).toMatchObject({ open: false, face: null })
  expect((await agent.raw('app_model_push_set', { distanceMm: 5 })).isError).toBe(true)

  // The person picks the top face and opens the tool.
  const b = await bounds(page, id)
  const top = await page.evaluate((p) => (window as unknown as { __vp: { screenOf(p: number[]): [number, number] } }).__vp.screenOf(p), [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]])
  await page.mouse.click(top[0], top[1])
  await expect(page.getByTestId('model-select-readout')).toHaveText('1 face on Box')
  await command(page, 'Push or pull a face')
  await expect(page.getByTestId('push-view-box')).toBeVisible()
  expect(await agent.call('app_model_push')).toMatchObject({ open: true, face: { object: id }, distanceMm: null, operation: null })

  // The client types a cut; the box shows it, and nothing changes until the person applies it. A bad value is
  // refused before it leaves (app-model-push.test.ts:43).
  expect(await agent.call('app_model_push_set', { distanceMm: -3 })).toMatchObject({ open: true, distanceMm: -3, operation: 'cut' })
  await expect(distance).toHaveValue('-3')
  await expect(page.getByTestId('push-view-op')).toHaveText('Cut')
  expect(await height()).toBe(h0)

  // The person types over it; the client reads that back.
  await distance.fill('2')
  expect(await agent.call('app_model_push')).toMatchObject({ distanceMm: 2, operation: 'pull' })

  // The client reads the operation preview: a pull, tinted; then a value that does not read keeps it with an error.
  expect(await agent.call('app_model_op_preview')).toMatchObject({ open: true, tool: 'push', status: 'ok', adds: true, removes: false, showingLastGood: false, message: null })
  await distance.fill('2x')
  await expect(page.getByTestId('push-view-error')).toBeVisible()
  expect(await agent.call('app_model_op_preview')).toMatchObject({ status: 'error', adds: true, showingLastGood: true, message: 'Type a number, such as 5 or -3. Showing the last good preview.' })
  await distance.fill('2')

  // The command line: slicerx-mcp call, one JSON line per call, the typed distance and its read-back.
  const lines = await agent.cli('app_model_push_set', { distanceMm: 4 }, 'app_model_push')
  expect(lines.map((l) => l.ok)).toEqual([true, true])
  expect(lines[1]!.output.output).toMatchObject({ distanceMm: 4, operation: 'pull' })
  await expect(distance).toHaveValue('4')
  // the person applies it
  await distance.press('Enter')
  await expect.poll(height, { timeout: 30_000 }).toBe(h0 + 4)
})

// The nine commands (cut, split, mirror, array, repair, hollow, emboss, build, subtract) are one case each in
// app-link-modeling.test.ts:38 on the real engine and reach an MCP client in modeling-client.test.ts:25, so a cut stands for them.
test('a mesh modeling command edits a live body with shared history through the hub', async ({ page, link }) => {
  test.slow()
  await cleanPlate(page)
  await scratch('modeling', async (dir) => {
    const editor = await session(link, page, dir, 'modeling-editor', 'edit')
    try {
      const design = (await editor.ok('design_new', { name: 'cut block' })).design
      await editor.ok('geom_extrude', { design, ...slab })
      const made = await editor.call('geom_cut', { design, plane: { axis: 'z', at: 4 }, keep: 'both' })
      expect(made.isError, JSON.stringify(made)).not.toBe(true)
      expect(made.structuredContent!.output).toMatchObject({ in: 'app', steps: 2, parts: [{}, {}], volumeMm3: expect.closeTo(1600, 1) })
      expect(JSON.stringify(made)).not.toMatch(/positions|indices/)
      const history = (await editor.ok('design_steps', { design })).steps as { state: string }[]
      expect(history).toHaveLength(2)
      expect(history.every((s) => s.state === 'done')).toBe(true)
      await editor.ok('design_undo', { design })
      expect((await editor.ok('design_steps', { design })).steps).toHaveLength(1)
    } finally {
      await editor.close()
    }
  })
})

// The shell, the readback of a historical step and the failures of an impossible shell are app-link-inspect.test.ts:21/37/53;
// the client path without an engine is app-cad-client.test.ts:13.
test('shell and measurement commands operate on the live body', async ({ page, link }) => {
  test.slow()
  await cleanPlate(page)
  await scratch('inspect', async (dir) => {
    const editor = await session(link, page, dir, 'inspect-editor', 'edit')
    try {
      const design = (await editor.ok('design_new', { name: 'Measured tray' })).design
      await editor.ok('geom_extrude', { design, ...slab })
      const shell = { design, open: [{ at: [0, 0, 8], normal: [0, 0, 1] }], wall_mm: 1 }
      expect(await editor.call('geom_shell', shell)).toMatchObject({ structuredContent: { output: { in: 'app', steps: 2 } } })
      expect(await editor.call('geom_info', { design })).toMatchObject({ structuredContent: { output: { in: 'app', parts: [{ watertight: true, volumeMm3: expect.closeTo(592, 3) }] } } })
      expect(await editor.call('geom_measure', { design, a: { at: [0, 0, 1], normal: [0, 0, 1] }, b: { at: [0, 0, 0], normal: [0, 0, -1] } })).toMatchObject({ structuredContent: { output: { in: 'app', measurement: { distanceMm: 1 } } } })
      await editor.ok('design_undo', { design })
      expect(await editor.call('geom_info', { design })).toMatchObject({ structuredContent: { output: { parts: [{ volumeMm3: expect.closeTo(1600, 4) }] } } })
    } finally {
      await editor.close()
    }
  })
})

// Busy and stale revisions, redo by command and the no-op redo are app-link-history.test.ts:36/48/62/74 and app-history.test.ts:16/53.
test('project Undo and Redo share toolbar history and return restored geometry through the hub', async ({ page, link }) => {
  test.slow()
  await cleanPlate(page)
  await scratch('history', async (dir) => {
    const editor = await session(link, page, dir, 'history-editor', 'edit')
    try {
      const state = async () => (await editor.ok('app_history')) as { revision: string; redo: number; changed?: boolean; plates: { objects: { id: string; minMm: number[]; sizeMm: number[] }[] }[] }
      const design = (await editor.ok('design_new', { name: 'History bracket' })).design
      await editor.ok('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
      const original = (await state()).plates.flatMap((p) => p.objects).find((o) => o.id === design)!
      expect(original.sizeMm).toEqual([20, 10, 3])
      await editor.ok('project_move', { object: design, x: 50, y: 60 })
      const moved = await state()
      expect(moved.plates[0]!.objects.find((o) => o.id === design)?.minMm).toEqual([40, 55, 0])
      const undone = await editor.ok('app_undo', { revision: moved.revision })
      expect(undone).toMatchObject({ changed: true, redo: 1 })
      expect(undone.plates.flatMap((p: { objects: unknown[] }) => p.objects).find((o: { id: string }) => o.id === design)).toMatchObject(original)
      // The toolbar uses the very same redo stack as the command.
      await page.getByTestId('plate-tools-group').getByRole('button', { name: 'Redo', exact: true }).click()
      const toolbar = await state()
      expect(toolbar.redo).toBe(0)
      expect(toolbar.plates).toEqual(moved.plates)
    } finally {
      await editor.close()
    }
  })
})

// Unbinding, editing a step, broken expressions and removal are app-link-values.test.ts:37/60/79/103. The test ends
// by unbinding and removing its value so the next one starts without it.
test('project expressions update a bound solid over MCP', async ({ page, link }) => {
  test.slow()
  await cleanPlate(page)
  await scratch('values', async (dir) => {
    const editor = await session(link, page, dir, 'value-editor', 'edit')
    try {
      await editor.ok('app_value_set', { name: 'height', expression: '3' })
      const design = (await editor.ok('design_new', { name: 'Bound bracket' })).design
      await editor.ok('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
      await editor.ok('app_step_bind', { design, step: 1, expression: 'height * 2' })
      await editor.ok('app_value_set', { name: 'height', expression: '5' })
      expect(await editor.call('app_values')).toMatchObject({ structuredContent: { output: { values: [{ name: 'height', value: 5 }], bindings: [{ design, value: 10, state: 'current' }] } } })
      expect(await editor.call('design_steps', { design })).toMatchObject({ structuredContent: { output: { sizeMm: [20, 10, 10], volumeMm3: 2000 } } })
      await editor.ok('design_edit_step', { design, step: 1, value: 7 })
      await editor.ok('app_value_remove', { name: 'height' })
      expect(await editor.call('app_values')).toMatchObject({ structuredContent: { output: { values: [], bindings: [], issues: [] } } })
    } finally {
      await editor.close()
    }
  })
})

// Copying, roles, removing and converting an object are app-link-volumes.test.ts:58/129 and app-volumes.test.ts:9; a bad patch is :81.
test('clients edit live volumes with read-back and toolbar Undo', async ({ page, link }) => {
  test.slow()
  await cleanPlate(page)
  await scratch('volumes', async (dir) => {
    const editor = await session(link, page, dir, 'volume-editor', 'edit')
    try {
      const design = (await editor.ok('design_new', { name: 'Volume block' })).design
      await editor.ok('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, distance_mm: 3 })
      const read = async () => (await editor.ok('app_volumes', { object: design })).volumes as { id: string; role: string; settings: Record<string, unknown>; positionMm: number[]; sizeMm: number[] }[]
      expect(await read()).toEqual([])
      const added = await editor.ok('app_volume_add', { object: design, role: 'modifier', shape: 'box', sizeMm: [8, 6, 3], settings: { wall_loops: 4 } })
      const id = added.changed[0]
      expect(added.volumes[0]).toMatchObject({ id, role: 'modifier', settings: { wall_loops: 4 } })
      const changed = await editor.ok('app_volume_set', { object: design, volume: id, positionMm: [3, 2, 1], rotationDeg: [0, 0, 30], set: { wall_loops: 6 } })
      expect(changed.volumes[0]).toMatchObject({ positionMm: [3, 2, 1], settings: { wall_loops: 6 } })
      expect(await read()).toEqual(changed.volumes)
      await page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true }).click()
      expect((await read())[0]?.settings).toEqual({ wall_loops: 4 })
    } finally {
      await editor.close()
    }
  })
})

// Scoped refusals and receipts are cad-topology.test.ts:44/70/91/118, on a mesh stand-in; this is the exact kernel behind a real hub.
test('scoped exact hole edits use app revisions across a visible undo', async ({ page, link }) => {
  test.setTimeout(180_000)
  await cleanPlate(page)
  const fallbacks: string[] = []
  const onConsole = (m: { text(): string }) => {
    if (/exact solids:.*ran on the mesh/.test(m.text())) fallbacks.push(m.text())
  }
  page.on('console', onConsole)
  // Exact designs need the developer exact-solids option: the flag and the mode, both put back below.
  const mode = await sx.get(page, 'settingsMode')
  await page.evaluate(() => {
    localStorage.setItem('sx.exactSolids', '1')
    ;(window as unknown as { __sx: { setState(v: unknown): void } }).__sx.setState({ settingsMode: 'developer' })
  })
  try {
    await scratch('topology', async (dir) => {
      const editor = await session(link, page, dir, 'topology-editor', 'edit')
      try {
        type Summary = { design: string; exact: boolean; parts: { sizeMm: number[]; volumeMm3: number }[] }
        const design = ((await editor.ok('design_new', { name: 'Scoped bracket', exact: true })) as Summary).design
        await editor.ok('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 30, heightMm: 10 }, placement: { center: [15, 5] }, distance_mm: 3 })
        await editor.ok('geom_extrude', { design, shape: { type: 'circle', diameterMm: 3 }, frame: { origin: [0, 0, 3], normal: [0, 0, 1] }, placement: { center: [5, 5] }, distance_mm: 3, operation: 'cut' })
        const before: Summary = await editor.ok('geom_extrude', { design, shape: { type: 'rectangle', widthMm: 6, heightMm: 8 }, placement: { center: [50, 5] }, distance_mm: 4 })
        const topology = async (): Promise<TopologyManifest> => (await editor.ok('geom_faces', { design, format: 'topology' })).topology
        const read = await topology()
        expect(read).toMatchObject({ representation: 'exact', capabilities: { meshFallback: false, revisionGuard: true } })
        const faces = read.faces.filter((f) => f.part === 0 && f.surfaceType === 'cylinder' && f.ambiguity === 'none')
        expect(faces).toHaveLength(1)
        const reference = { bodyId: design, revision: read.revision, part: 0, faceKey: faces[0]!.faceKey }
        const edited = await editor.ok('geom_hole', { design, face: { topology: reference }, diameter_mm: 4 })
        expect(edited.operationResult).toMatchObject({ status: 'applied', verification: { status: 'verified' } })
        expect(edited.after.diameterMm).toBeCloseTo(4, 2)
        expect(edited.parts[1]).toEqual(before.parts[1])
        expect(edited.parts.map((p: { sizeMm: number[] }) => p.sizeMm)).toEqual(before.parts.map((p) => p.sizeMm))
        await page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true }).click()
        const undone = await topology()
        expect(undone.revision).not.toBe(read.revision)
        expect(undone.revision).not.toBe(edited.topology.revision)
        expect(undone.faces.find((f) => f.part === 0 && f.surfaceType === 'cylinder')?.dimensions.diameterMm).toBeCloseTo(3, 2)
        const stale = await editor.call('geom_hole', { design, face: { topology: reference }, diameter_mm: 5 })
        expect(stale).toMatchObject({ isError: true, structuredContent: { error: { code: 'stale_body', details: { operationResult: { status: 'refused' } } } } })
        expect((await topology()).revision).toBe(undone.revision)
        expect(fallbacks).toEqual([])
      } finally {
        await editor.close()
      }
    })
  } finally {
    page.off('console', onConsole)
    await page.evaluate((mode) => {
      localStorage.removeItem('sx.exactSolids')
      ;(window as unknown as { __sx: { setState(v: unknown): void } }).__sx.setState({ settingsMode: mode })
    }, mode)
  }
})

test('clients change display units with visible read-back, native CLI and persistent preferences', async ({ page, link }) => {
  test.slow()
  await cleanPlate(page, 'design')
  await scratch('units', async (dir) => {
    const reader = await session(link, page, dir, 'units-reader', 'read')
    try {
      await command(page, 'Add a box')
      await expect(page.getByLabel('Model size')).toContainText('20')
      const before = await reader.ok('app_history')
      const read = () => reader.ok('app_units')
      const inches = await reader.ok('app_units_set', { length: 'in', precision: { decimals: 3 } })
      expect(inches).toMatchObject({ available: true, length: 'in', precision: { decimals: 3 }, millimetersPerUnit: 25.4, dataUnit: 'mm' })
      expect(await read()).toEqual(inches)
      await expect(page.getByLabel('Model size')).toContainText('0.787 x 0.787 x 0.787 in')
      const settings = async () => {
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'Settings' })
        await dialog.getByRole('button', { name: /Slicing and modeling|Modeling/ }).first().click()
        return dialog
      }
      const dialog = await settings()
      await expect(dialog.getByTestId('set-precision-pick')).toHaveValue('d3')
      await dialog.getByTestId('set-precision-pick').selectOption('f32')
      expect(await read()).toMatchObject({ length: 'in', precision: { fraction: 32 }, inchDigits: 3, inchFraction: 32 })
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(page.getByLabel('Model size')).toContainText('25/32 x 25/32 x 25/32 in')
      const unchanged = await read()
      expect(await reader.call('app_units_set', { length: 'mm', precision: { fraction: 32 } })).toMatchObject({ isError: true, structuredContent: { error: { code: 'invalid_input' } } })
      expect(await read()).toEqual(unchanged)
      expect(await reader.ok('app_history')).toEqual(before)
      if (process.platform === 'win32') {
        await windowsCli(link, dir, reader.clientKey!, async (run) => {
          const rows = await run('app_units_set', { length: 'mm', precision: { decimals: 2 } }, 'app_units')
          expect(rows).toHaveLength(2)
          for (const row of rows) {
            expect(row.ok).toBe(true)
            expect(row.output.output).toMatchObject({ length: 'mm', precision: { decimals: 2 }, millimetersPerUnit: 1, dataUnit: 'mm' })
          }
          expect(rows[0].output.output).toEqual(rows[1].output.output)
          expect(await read()).toEqual(rows[1].output.output)
        })
        await expect(page.getByLabel('Model size')).toContainText('20 x 20 x 20 mm')
      }
      await reader.ok('app_units_set', { length: 'in' })
      expect(await read()).toMatchObject({ length: 'in', precision: { fraction: 32 } })
      expect(await reader.ok('app_history')).toEqual(before)
      // A reload keeps the choice; the page pairs with the hub again on its own.
      await page.reload()
      await plateReady(page)
      await expect.poll(async () => (await sx.get(page, 'bridgeStatus')).state, { timeout: 30_000 }).toBe('on')
      const restored = await settings()
      await expect(restored.getByTestId('set-precision-pick')).toHaveValue('f32')
      await restored.getByTestId('set-units-mm').click()
      await expect(restored.getByTestId('set-precision-pick')).toHaveValue(process.platform === 'win32' ? 'd2' : `d${inches.mmDigits}`)
      await page.keyboard.press('Escape')
    } finally {
      await reader.close()
    }
  })
})

test('a read client changes the real Model pick filter and reads UI picks through the SDK and native CLI', async ({ page, link }) => {
  test.slow()
  await cleanPlate(page)
  await scratch('pick-filter', async (dir) => {
    const reader = await session(link, page, dir, 'pick-filter-reader', 'read')
    try {
      const read = () => reader.ok('app_pick_filter')
      expect(await read()).toMatchObject({ available: false })
      expect(await reader.call('app_pick_filter_set', { kind: 'object' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
      await tab(page, 'model').click()
      await command(page, 'Add a box')
      await expect.poll(async () => (await read()).objects.some((o: { name: string }) => o.name === 'Box')).toBe(true)
      const id = (await read()).primary as string
      const filter = (kind: string) => page.locator(`[data-testid="model-select-filter"][data-kind="${kind}"]`)
      await expect(filter('face')).toBeVisible()
      const history = await reader.ok('app_history')
      const face = await reader.ok('app_pick_filter_set', { kind: 'face' })
      expect(face).toMatchObject({ available: true, pickFilter: ['face'], primary: id })
      await expect(filter('face')).toHaveAttribute('aria-pressed', 'true')
      await expect(filter('object')).toHaveAttribute('aria-pressed', 'false')
      await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: { rig: { move: unknown } } }).__vp.rig.move === null)).toBe(true)
      const box = await bounds(page, id)
      const point = await page.evaluate((p) => (window as unknown as { __vp: { screenOf(p: number[]): [number, number] } }).__vp.screenOf(p), [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, box.max[2]])
      await page.mouse.click(point[0], point[1])
      await expect.poll(async () => (await read()).picks.length).toBe(1)
      expect((await read()).picks[0]).toMatchObject({ kind: 'face', objectId: id })
      await reader.ok('app_pick_filter_set', { kind: 'edge', mode: 'toggle' })
      expect(await read()).toMatchObject({ pickFilter: ['face', 'edge'], primary: id, picks: [{ kind: 'face' }] })
      await expect(filter('edge')).toHaveAttribute('aria-pressed', 'true')
      await filter('object').click()
      expect(await read()).toMatchObject({ pickFilter: ['object'], primary: id, picks: [] })
      await filter('face').click({ modifiers: ['Shift'] })
      expect(await read()).toMatchObject({ pickFilter: ['object', 'face'] })
      const before = await read()
      expect(await reader.call('app_pick_filter_set', { kind: 'edge', mode: 'invalid' })).toMatchObject({ isError: true })
      expect(await read()).toEqual(before)
      if (process.platform === 'win32') {
        await windowsCli(link, dir, reader.clientKey!, async (run) => {
          const rows = await run('app_pick_filter_set', { kind: 'edge', mode: 'only' }, 'app_pick_filter')
          expect(rows).toHaveLength(2)
          for (const row of rows) {
            expect(row.ok).toBe(true)
            expect(row.output.output).toMatchObject({ available: true, pickFilter: ['edge'], primary: id, picks: [] })
          }
          expect(await read()).toMatchObject(rows[1].output.output)
          await expect(filter('edge')).toHaveAttribute('aria-pressed', 'true')
          await expect(filter('face')).toHaveAttribute('aria-pressed', 'false')
        })
      }
      expect((await reader.ok('app_history')).revision).toBe(history.revision)
      await command(page, 'Push or pull a face')
      await expect.poll(async () => (await read()).available).toBe(false)
      expect(await reader.call('app_pick_filter_set', { kind: 'face' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
      // Only the Windows block above narrows the filter to edge (it needs the Windows credential store); elsewhere it is still the earlier shift-click state.
      expect((await read()).pickFilter).toEqual(process.platform === 'win32' ? ['edge'] : ['object', 'face'])
    } finally {
      await reader.close()
      await page.keyboard.press('Escape')
      await sx.set(page, { pickFilter: ['face'] })
    }
  })
})

test('clients keep real dimensions with visible read-back, permissions, native CLI and toolbar Undo', async ({ page, link }) => {
  test.slow()
  await cleanPlate(page, 'design')
  await scratch('dimensions', async (dir) => {
    const editor = await session(link, page, dir, 'dimension-editor', 'edit')
    try {
      const prior = await editor.ok('app_history')
      const known = new Set(prior.plates.flatMap((p: { objects: { id: string }[] }) => p.objects.map((o) => o.id)))
      await command(page, 'Add a box')
      const added = async () => {
        const current = await editor.ok('app_history')
        return current.plates.flatMap((p: { objects: { id: string; sizeMm: number[] }[] }) => p.objects).filter((o: { id: string }) => !known.has(o.id))
      }
      await expect.poll(async () => (await added()).length).toBe(1)
      const box = (await added())[0]
      const id: string = box.id
      const height: number = box.sizeMm[2]
      expect(height).toBeCloseTo(20)
      const listed = await editor.ok('geom_faces', { design: id })
      type Face = { part: number; triangle: number; at: number[]; normal: number[] }
      const top = listed.faces.find((f: Face) => f.normal[2]! > 0.99) as Face
      const bottom = listed.faces.find((f: Face) => f.normal[2]! < -0.99) as Face
      expect(top).toBeTruthy()
      expect(bottom).toBeTruthy()
      const pick = (p: Face) => ({ object: id, part: p.part, triangle: p.triangle, at: p.at })
      const request = { kind: 'distance', a: pick(top), b: pick(bottom) }
      const read = () => editor.ok('app_dimensions')
      const before = await editor.ok('app_history')
      await command(page, 'Measure distance, angle and radius')
      const kept = await editor.ok('app_dimension_keep', request)
      expect(kept.dimensions).toHaveLength(1)
      expect(kept.dimensions[0]).toMatchObject({ id: kept.kept, status: 'ok', unit: 'mm', visible: true })
      expect(kept.dimensions[0].value).toBeCloseTo(height)
      expect((await read()).dimensions).toEqual(kept.dimensions)
      expect((await editor.ok('app_history')).undo).toBe(before.undo + 1)
      const list = page.getByRole('list', { name: 'Kept dimensions' })
      await expect(list).toContainText(`${height.toFixed(2)} mm`)
      const drawn = () => page.evaluate(() => {
        const group = (window as unknown as { __vp: { dims: { group: { children: { type: string; geometry?: { attributes: { position: { array: ArrayLike<number> } } } }[] } } } }).__vp.dims.group
        return Array.from(group.children.find((c) => c.type === 'LineSegments')?.geometry?.attributes.position.array ?? [])
      })
      await expect.poll(async () => (await drawn()).length).toBe(6)
      const vertices = await drawn()
      const annotation = kept.dimensions[0].annotation
      vertices.forEach((v, i) => expect(v).toBeCloseTo([...annotation.from, ...annotation.to][i], 3))
      const show = page.getByRole('switch', { name: 'Show all kept dimensions' })
      const revision = (await editor.ok('app_history')).revision
      await expect(show).toHaveAttribute('aria-checked', 'false')
      await show.click()
      await expect(show).toHaveAttribute('aria-checked', 'true')
      expect((await read()).showAll).toBe(true)
      await editor.ok('app_dimensions_show', { showAll: false })
      await expect(show).toHaveAttribute('aria-checked', 'false')
      expect((await editor.ok('app_history')).revision).toBe(revision)
      const reader = await session(link, page, dir, 'dimension-reader', 'read')
      try {
        expect(await reader.ok('app_dimensions')).toMatchObject({ dimensions: [{ id: kept.kept }] })
        expect(await reader.call('app_dimension_keep', request)).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
        expect(await reader.call('app_dimension_remove', { dimension: kept.kept })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
      } finally {
        await reader.close()
      }
      expect(await editor.call('app_dimension_keep', { ...request, value: 999 })).toMatchObject({ isError: true })
      expect((await read()).dimensions).toEqual(kept.dimensions)
      await page.getByRole('button', { name: 'Done', exact: true }).click()
      await editor.ok('project_scale', { object: id, scale: [1, 1, 2] })
      expect((await read()).dimensions[0].value).toBeCloseTo(height * 2)
      const undo = page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true })
      await undo.click()
      expect((await read()).dimensions[0].value).toBeCloseTo(height)
      if (process.platform === 'win32') {
        await windowsCli(link, dir, editor.clientKey!, async (run) => {
          const rows = await run('app_dimension_remove', { dimension: kept.kept }, 'app_dimensions')
          expect(rows).toHaveLength(2)
          for (const row of rows) {
            expect(row.ok).toBe(true)
            expect(row.output.output.dimensions).toEqual([])
          }
          expect(rows[0].output.output.removed).toBe(kept.kept)
          expect((await read()).dimensions).toEqual([])
        })
        await expect.poll(async () => (await drawn()).length).toBe(0)
        await undo.click()
        expect((await read()).dimensions[0].id).toBe(kept.kept)
      }
      await command(page, 'Measure distance, angle and radius')
      await expect(list).toContainText(`${height.toFixed(2)} mm`)
      await list.getByRole('button', { name: 'Remove the distance' }).click()
      expect((await read()).dimensions).toEqual([])
    } finally {
      await editor.close()
    }
  })
})

test('clients paint the live object through MCP and native CLI, read brush layers and undo', async ({ page, link }) => {
  test.slow()
  await cleanPlate(page)
  await command(page, 'Add a box')
  await expect.poll(async () => (await sx.get(page, 'plate')).length).toBe(1)
  type Paint = { preview?: string; revision: string; changed?: boolean; object: string; parts: { states: { state: number; areaMm2: number }[] }[] }
  await scratch('paint', async (dir) => {
    const objectOf = async (client: { ok(tool: string): Promise<any> }): Promise<string> => {
      const state = await client.ok('app_history')
      return state.plates.find((p: { id: string }) => p.id === state.activePlate).objects[0].id
    }
    const reader = await session(link, page, dir, 'paint-reader', 'read')
    try {
      const object = await objectOf(reader)
      const pv: Paint = (await reader.ok('app_paint_preview', { object, layer: 'seam', state: 1, target: { kind: 'direction', direction: 'top' } }))
      expect(pv.preview).toBeTruthy()
      expect(await reader.call('app_paint_apply', { preview: pv.preview })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
    } finally {
      await reader.close()
    }
    const editor = await session(link, page, dir, 'paint-editor', 'edit')
    try {
      const object = await objectOf(editor)
      const call = (name: string, args: Record<string, unknown>): Promise<Paint> => editor.ok(name, args)
      const undo = page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true })
      const exercise = async (native?: (name: string, args: Record<string, unknown>) => Promise<Paint>) => {
        const invoke = native ?? call
        for (const layer of ['color', 'seam', 'support', 'fuzzy']) {
          const initial = await invoke('app_paint', { object, layer })
          const pv = await invoke('app_paint_preview', { object, layer, state: 1, target: { kind: 'direction', direction: 'top' } })
          expect(pv.changed).toBe(true)
          expect((await call('app_paint', { object, layer })).parts).toEqual(initial.parts)
          const applied = await invoke('app_paint_apply', { preview: pv.preview })
          expect(applied.parts).toEqual(pv.parts)
          expect(applied.parts.flatMap((p) => p.states).some((s) => s.state === 1 && s.areaMm2 > 0)).toBe(true)
          expect((await call('app_paint', { object, layer })).parts).toEqual(applied.parts)
          await undo.click()
          expect((await call('app_paint', { object, layer })).parts).toEqual(initial.parts)
          const again = await call('app_paint_preview', { object, layer, state: 1, target: { kind: 'part' } })
          await call('app_paint_apply', { preview: again.preview })
          const painted = await call('app_paint', { object, layer })
          const cleared = await invoke('app_paint_clear', { object, layer, revision: painted.revision })
          expect(cleared.parts.every((p) => p.states.length === 0)).toBe(true)
          await undo.click()
          expect((await call('app_paint', { object, layer })).parts).toEqual(painted.parts)
          await undo.click()
          expect((await call('app_paint', { object, layer })).parts).toEqual(initial.parts)
        }
      }
      if (process.platform === 'win32') {
        await windowsCli(link, dir, editor.clientKey!, async (run) => {
          await exercise(async (name, args) => {
            const [row] = await run(name, args)
            expect(row.ok, JSON.stringify(row)).toBe(true)
            return row.output.output
          })
        })
      } else await exercise()
      const pv = await call('app_paint_preview', { object, state: 1, target: { kind: 'part' } })
      const next = await call('app_paint_preview', { object, layer: 'support', state: 1, target: { kind: 'part' } })
      await call('app_paint_apply', { preview: next.preview })
      expect(await editor.call('app_paint_apply', { preview: pv.preview })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
      await undo.click()
    } finally {
      await editor.close()
    }
  })
})

test('clients edit brim ears through MCP and the native CLI, read them back, undo and slice actual discs', async ({ page, link }) => {
  test.slow()
  await cleanPlate(page)
  await command(page, 'Add a box')
  await expect.poll(async () => (await sx.get(page, 'plate')).length).toBe(1)
  type Ear = { index: number; bedMm: number[]; localMm: number[]; diameterMm: number; connected: boolean }
  type Brim = { revision: string; changed?: boolean; objects: { id: string; enabled: boolean; ears: Ear[] }[] }
  const brimType = page.locator('#expert-panel').getByLabel('Brim type', { exact: true })
  let wasType: string | undefined
  await scratch('brim', async (dir) => {
    const reader = await session(link, page, dir, 'brim-reader', 'read')
    try {
      const state: Brim = await reader.ok('app_brim_ears')
      expect(await reader.call('project_brim_ears', { object: state.objects[0]!.id, revision: state.revision, action: 'generate' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported' } } })
    } finally {
      await reader.close()
    }
    const editor = await session(link, page, dir, 'brim-editor', 'edit')
    try {
      const initial: Brim = await editor.ok('app_brim_ears')
      const object = initial.objects[0]!.id
      const read = (): Promise<Brim> => editor.ok('app_brim_ears', { object })
      const edit = async (args: Record<string, unknown>): Promise<Brim> => editor.ok('project_brim_ears', { object, revision: (await read()).revision, ...args })
      await edit({ action: 'generate', diameter_mm: 10 })
      const generated = await read()
      expect(generated.objects[0]!.ears.length).toBeGreaterThanOrEqual(3)
      expect(generated.objects[0]!.ears.every((e) => e.connected)).toBe(true)
      expect(await editor.call('project_brim_ears', { object, revision: initial.revision, action: 'clear' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'busy' } } })
      const undo = page.getByTestId('plate-tools-group').getByRole('button', { name: 'Undo', exact: true })
      await undo.click()
      expect((await read()).objects[0]!.ears).toEqual([])
      const [x, y] = generated.objects[0]!.ears[0]!.bedMm
      const actions = [
        { action: 'add', x_mm: x, y_mm: y, diameter_mm: 10 },
        { action: 'move', indices: [0], x_mm: x! + 0.5, y_mm: y },
        { action: 'resize', indices: [0], diameter_mm: 12 },
        { action: 'remove', indices: [0] },
        { action: 'generate', diameter_mm: 10 },
        { action: 'clear' },
      ]
      const outputs: Brim[] = []
      if (process.platform === 'win32') {
        await windowsCli(link, dir, editor.clientKey!, async (run) => {
          for (const action of actions) {
            const args = { object, revision: (await read()).revision, ...action }
            const rows = await run('project_brim_ears', args, 'app_brim_ears', { object })
            expect(rows).toHaveLength(2)
            expect(rows.every((row) => row.ok)).toBe(true)
            expect(rows[0].output.output.changed).toBe(true)
            expect(rows[1].output.output.objects).toEqual(rows[0].output.output.objects)
            expect((await read()).objects).toEqual(rows[1].output.output.objects)
            outputs.push(rows[1].output.output)
          }
        })
      } else {
        for (const action of actions) {
          await edit(action)
          outputs.push(await read())
        }
      }
      expect(outputs[0]!.objects[0]!.ears[0]!.bedMm[0]).toBeCloseTo(x!, 3)
      expect(outputs[1]!.objects[0]!.ears[0]!.bedMm[0]).toBeCloseTo(x! + 0.5, 3)
      expect(outputs[2]!.objects[0]!.ears[0]!.diameterMm).toBe(12)
      expect(outputs[3]!.objects[0]!.ears).toEqual([])
      expect(outputs[4]!.objects[0]!.ears.length).toBeGreaterThanOrEqual(3)
      expect(outputs[5]!.objects[0]!.ears).toEqual([])
      for (let i = outputs.length - 1; i >= 0; i--) {
        await undo.click()
        const ears = (await read()).objects[0]!.ears
        expect(ears).toEqual(i === 0 ? [] : outputs[i - 1]!.objects[0]!.ears)
      }
      await edit({ action: 'generate', diameter_mm: 10 })
      await page.keyboard.press('ControlOrMeta+k')
      await page.locator('.sx-palette-input').fill('brim type')
      await page.locator('.sx-palette-item', { hasText: 'now' }).first().click()
      wasType = await brimType.inputValue()
      await brimType.selectOption('painted')
      expect((await read()).objects[0]!.enabled).toBe(true)
      const count = await sliceCount(page)
      await page.getByRole('main').getByRole('button', { name: 'Slice plate', exact: true }).click()
      await expect(sliced(page, count)).toBeVisible({ timeout: 120_000 })
      await page.evaluate(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export G-code' }).click()])
      const text = readFileSync(await download.path(), 'utf8')
      const mark = text.includes('\n; CHANGE_LAYER\n') ? '; CHANGE_LAYER' : ';LAYER_CHANGE'
      const firstLayer = text.slice(text.indexOf(mark), text.indexOf(mark, text.indexOf(mark) + 1))
      expect(firstLayer).toMatch(/;\s*(?:TYPE|FEATURE):\s*Brim/)
    } finally {
      await editor.close()
      // The brim type is a print setting the next test would find still on painted.
      if (wasType !== undefined) await brimType.selectOption(wasType)
    }
  })
})

// Run against the default app or a JSON edition named by SLICERX_CONFIG. Both modes must reach the rendered art and the
// client read-back. The computed CSS on the SVG icons and loops is what no unit test sees, so this keeps all of it.
test('edition colors reach icons, loops, the viewport and MCP in both themes', async ({ page, link }, info) => {
  test.slow()
  const configPath = process.env['SLICERX_CONFIG']
  const config = configPath?.endsWith('.json') ? JSON.parse(readFileSync(configPath, 'utf8')) : undefined
  const theme = config?.brand?.theme
  const agreement = page.getByTestId('agreement-check')
  if (await agreement.isVisible()) {
    await agreement.check()
    await page.getByTestId('agreement-accept').click()
  }
  await cleanPlate(page, 'design')
  await viewportReady(page)
  const phone = { width: 390, height: 844 }
  const desktop = info.project.use.viewport ?? { width: 1440, height: 900 }
  const was = { scheme: await sx.get(page, 'scheme'), follows: await sx.get(page, 'themeFollowsSystem') }
  type Look = { theme: { scheme: string; visuals: Record<string, string>; overrides: Record<string, string> } }
  await scratch('theme', async (dir) => {
    const reader = await session(link, page, dir, 'theme-reader', 'read')
    const read = async () => {
      const answer = await reader.call('app_look')
      expect(answer.isError, JSON.stringify(answer)).not.toBe(true)
      return (answer.structuredContent!.output as Look).theme
    }
    try {
      for (const scheme of ['dark', 'light'] as const) {
        const values: Record<string, string> = { ...theme?.tokens?.visuals, ...theme?.[scheme]?.visuals }
        await page.setViewportSize(desktop)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await sx.set(page, { scheme, themeFollowsSystem: false })
        await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme)
        const readBack = await read()
        expect(readBack.scheme).toBe(scheme)
        expect(readBack.overrides).toEqual(values)
        for (const [key, value] of Object.entries(values)) expect(readBack.visuals[key], key).toBe(value)
        if (values['--stage-a1']) {
          const luminance = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0)
          const a = luminance(values['--stage-a1'])
          const b = luminance(readBack.visuals['--stage-pill']!)
          expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), 'Add badge text contrast').toBeGreaterThanOrEqual(4.5)
        }
        const ribbon = page.getByTestId('model-shelf')
        await expect(ribbon).toBeVisible()
        await expect(ribbon.locator('svg.ti').first()).toHaveAttribute('width', '32')
        const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ')})`
        if (values['--ti-a1']) await expect(ribbon.locator('svg.ti .a1').first()).toHaveCSS('fill', rgb(values['--ti-a1']))
        if (values['--accent']) {
          await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: { theme: { scene: { selection: string } } } }).__vp.theme.scene.selection)).toBe(values['--accent'])
        }
        if (process.env['SX_SHOTS']) await page.screenshot({ path: info.outputPath(`${config?.id ?? 'default'}-${scheme}-ribbon.png`) })
        const loop = async () => {
          await page.locator('[data-tool="push"]:visible').first().hover()
          const tip = page.locator('#sx-tip')
          await expect(tip).toHaveAttribute('data-ready', 'true')
          await expect(tip.locator('.sx-stage svg.sxs')).toBeVisible()
          if (values['--stage-a2']) await expect(tip.locator('.sxs .s-g2').first()).toHaveCSS('fill', rgb(values['--stage-a2']))
          if (values['--stage-grid']) await expect(tip.locator('.sxs-grid')).toHaveCSS('stroke', rgb(values['--stage-grid']))
          await expect(tip.locator('.s-a').first()).toHaveCSS('animation-play-state', 'paused')
          return tip
        }
        let tip = await loop()
        // A scoped studio color still supplies the default grid; an explicit loop override wins over it.
        await tip.evaluate((el) => el.style.setProperty('--scene-grid', '#123456'))
        await expect(tip.locator('.sxs-grid')).toHaveCSS('stroke', rgb(values['--stage-grid'] ?? '#123456'))
        await tip.evaluate((el) => el.style.removeProperty('--scene-grid'))
        if (process.env['SX_SHOTS']) await page.screenshot({ path: info.outputPath(`${config?.id ?? 'default'}-${scheme}-loop.png`) })
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        await expect(tip.locator('.s-a').first()).toHaveCSS('animation-play-state', 'running')
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.mouse.move(0, 0)
        await page.setViewportSize(phone)
        tip = await loop()
        const box = (await tip.boundingBox())!
        expect(box.x).toBeGreaterThanOrEqual(0)
        expect(box.x + box.width).toBeLessThanOrEqual(phone.width)
        if (process.env['SX_SHOTS']) await page.screenshot({ path: info.outputPath(`${config?.id ?? 'default'}-${scheme}-phone-loop.png`) })
      }
    } finally {
      await reader.close()
      await page.setViewportSize(desktop)
      await page.emulateMedia({ reducedMotion: null })
      await page.mouse.move(0, 0)
      await sx.set(page, { scheme: was.scheme, themeFollowsSystem: was.follows })
    }
  })
})

// The open edition's assistant identity needs a build of that edition (SX_E2E_ASSISTANT_EDITION=1), so it is gated as it always was.
test.describe('assistant edition', () => {
  test.skip(process.env['SX_E2E_ASSISTANT_EDITION'] !== '1', 'requires the assistant edition build')

  test('MCP and CLI read the open edition assistant identity', async ({ page, link }) => {
    test.slow()
    await cleanPlate(page)
    const { clientKey } = await link.hub.admin.clients.create('assistant identity test', 'agent')
    const sdk = (id: string) => import(pathToFileURL(mcpRequire.resolve(id)).href) as Promise<Record<string, any>>
    const { Client } = await sdk('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = await sdk('@modelcontextprotocol/sdk/client/stdio.js')
    await scratch('assistant', async (dir) => {
      const env = {
        ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string' && !e[0].startsWith('SLICERX_MCP_LINK') && e[0] !== 'SLICERX_CONFIG')),
        SLICERX_MCP_LINK_KEY_REF: 'slicerx-agent-assistant-test',
        SX_TEST_AGENT_KEY: clientKey!,
      }
      // Isolate credential storage only. Windows has no MCP keychain reader yet; the hub, app and sx remain real.
      const credential = join(dir, 'credential.cjs')
      writeFileSync(credential, `
        const cp = require('node:child_process');
        const original = cp.execFileSync;
        const platform = process.platform;
        Object.defineProperty(process, 'platform', { get() { return new Error().stack?.includes('readKeychainKey') ? 'linux' : platform; } });
        cp.execFileSync = function(command, args, options) {
          if (command === 'secret-tool' && args.join(' ') === 'lookup service slicerx-agent-assistant-test username slicerx') return process.env.SX_TEST_AGENT_KEY;
          return original.apply(this, arguments);
        };
        require('node:module').syncBuiltinESMExports();
      `)
      const args = ['--require', credential, '--import', pathToFileURL(mcpRequire.resolve('tsx')).href, 'src/cli.ts', '--engine', 'sx', '--sx-bin', process.env['SX_CLI_BIN']!, '--printers', 'link', '--link-url', link.hub.url, '--link-state-dir', link.hub.stateDir, '--out-dir', join(dir, 'out'), '--profiles-dir', join(dir, 'profiles')]
      const client = new Client({ name: 'assistant-identity-test', version: '0.0.0' })
      try {
        await client.connect(new StdioClientTransport({ command: process.execPath, args, cwd: mcpDir, env }))
        const answer = client.callTool({ name: 'slicerx_app_assistant', arguments: {} })
        const allow = page.getByTestId('app-link-allow')
        await expect(allow).toBeEnabled()
        await allow.click()
        const result = (await answer) as Answer
        expect(result.isError, JSON.stringify(result)).toBeFalsy()
        const identity = result.structuredContent!.output
        expect(identity).toMatchObject({ name: 'yourmate', accent: { light: '#006b65', dark: '#63e6d4' }, enabled: true })
        expect(identity.icon).toMatch(/^data:image\/svg\+xml,/)
        await client.close()
        const { stdout } = await promisify(execFile)(process.execPath, [...args, 'call', 'app_assistant'], { cwd: mcpDir, env, timeout: 90_000 })
        const lines = stdout.trim().split('\n').map((line) => JSON.parse(line))
        expect(lines).toHaveLength(1)
        expect(lines[0].ok).toBe(true)
        expect(lines[0].output.output).toEqual(identity)
      } finally {
        await client.close()
      }
    })
  })
})
