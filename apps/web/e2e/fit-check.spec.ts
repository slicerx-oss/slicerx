// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fit check on the Vault's starters, made by the same generator: every one opens alone with no notes, a separate
// object that touches warns and its marker goes the moment it is dragged away. A design with a real gap is a fixture
// of its own (fixtures/loose-clip.sx3mf: an earlier cable clip, our own geometry, whose ring floats 0.76 mm off its
// foot), so no starter has to keep a fault. Opening a design starts a new project, so designs never pile up. Moving
// an object never rebuilds the scene.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type FileChooser, type Page } from '@playwright/test'
import { plateReady, pnpmSync, viewportReady } from './fixtures'

type Entry = { id: string; name: string; transform: number[]; parts: { positions: ArrayLike<number> }[] }
type Sx = { getState(): { plate: Entry[]; slice: { status: string; stale?: boolean; result?: { id: string; primeTower?: unknown } } }; setState(p: unknown): void }
const STARTERS = ['x-mark', 'calibration-cube-20mm', 'wall-hook', 'shelf-bracket', 'first-layer-test', 'overhang-test', 'bridging-test', 'retraction-test', 'temperature-tower', 'cable-clip']
interface Vp {
  camera: { position: { clone(): { set(x: number, y: number, z: number): { applyMatrix4(m: unknown): { project(c: unknown): { x: number; y: number } } } } } }
  stage: { bedRoot: { matrixWorld: unknown } }
  canvas: HTMLCanvasElement
  gaps: { group: { children: { visible: boolean; children: { matrixWorld: { elements: number[] } }[] }[] } }
  objects: Map<string, { group: { matrixWorld: { elements: number[] } } }>
  setPlate(...a: unknown[]): void
}

const root = join(import.meta.dirname, '..', '..', '..')
let starters = ''

test.beforeAll(() => {
  // The starters are made in code; the output never goes in git.
  starters = mkdtempSync(join(tmpdir(), 'sx-starters-'))
  pnpmSync(['--filter', '@slicerx/store', 'exec', 'tsx', '../app/scripts/vault-starters.ts', starters], root)
})

// The file dialogs each page opened, oldest first. The listener is on from the start, so every dialog is intercepted.
// Waiting for one only around the key press turns interception on at the same time as the press, and on a busy page
// the press can open the dialog first: it then opens for real, the headless browser cancels it at once, and the press
// looks lost.
const choosers = new WeakMap<Page, FileChooser[]>()

async function open(page: Page): Promise<void> {
  const seen: FileChooser[] = []
  choosers.set(page, seen)
  page.on('filechooser', (c) => seen.push(c))
  await page.addInitScript(() => {
    // Where each O key went, for pick()'s note: how late the page got it, whether it had a user activation, whether a
    // capture handler stopped it (it never reached the document), whether the app took it, and every file input click.
    const keys: string[] = []
    ;(window as unknown as { __sxKeys: string[] }).__sxKeys = keys
    window.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() !== 'o') return
      const late = Math.round(performance.now() - e.timeStamp)
      const active = navigator.userActivation?.isActive
      let reached = false
      const reach = () => (reached = true)
      document.addEventListener('keydown', reach, { once: true })
      setTimeout(() => {
        document.removeEventListener('keydown', reach)
        keys.push(`${e.ctrlKey || e.metaKey ? 'Mod+' : ''}O ${late} ms late, activation ${active}, reached the document ${reached}, taken ${e.defaultPrevented}`)
      })
    }, true)
    const click = HTMLInputElement.prototype.click
    HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
      if (this.type === 'file') keys.push(`file input clicked, activation ${navigator.userActivation?.isActive}`)
      click.call(this)
    }
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', sliceLook: 'toolpaths', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await viewportReady(page)
}

/**
 * Presses Open (Mod+O) once and answers the dialog it opens with `path`. On the GPU runner the first Mod+O after a
 * load sometimes opens no dialog (#291): when none has come after 10 s, the test notes what could have held the key
 * (an open dialog or panel in the app's state, the focused element, the O keys the page saw) before it goes on
 * waiting, so a failure says why.
 */
async function pick(page: Page, path: string): Promise<void> {
  const seen = choosers.get(page)!
  const before = seen.length
  await page.keyboard.press('ControlOrMeta+o')
  const came = await expect.poll(() => seen.length, { timeout: 10_000 }).toBe(before + 1).then(() => true, () => false)
  if (!came) {
    const held = await page.evaluate(() => {
      const s = (window as unknown as { __sx: { getState(): Record<string, unknown> } }).__sx.getState()
      const flags = ['setup', 'commandOpen', 'approval', 'aboutOpen', 'settingsOpen', 'shortcutsOpen'].filter((k) => Boolean(s[k]))
      const a = document.activeElement
      const focus = a ? `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}${a.getAttribute('aria-label') ? ` "${a.getAttribute('aria-label')}"` : ''}` : 'none'
      const keys = (window as unknown as { __sxKeys: string[] }).__sxKeys.join('; ') || 'none'
      return `open in the app: ${flags.join(', ') || 'nothing'}; focus: ${focus}; dialogs on screen: ${document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length}; O keys: ${keys}`
    })
    test.info().annotations.push({ type: 'Mod+O opened no dialog in 10 s', description: held })
    console.log(`fit-check: Mod+O opened no dialog in 10 s (${held})`)
    await expect.poll(() => seen.length, { timeout: 50_000 }).toBe(before + 1)
  }
  await seen[before]!.setFiles(path)
}

/** Open (Mod+O): a new project with the file. */
async function openFile(page: Page, file: string): Promise<void> {
  await pick(page, join(starters, file))
}

/** Open (Mod+O) with a file from e2e/fixtures. */
async function openFixture(page: Page, file: string): Promise<void> {
  await pick(page, join(import.meta.dirname, 'fixtures', file))
}

/** A drop adds the file to the plate. */
async function drop(page: Page, file: string): Promise<void> {
  const bytes = [...readFileSync(join(starters, file))]
  await page.evaluate(({ file, bytes }) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(bytes)], file))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, { file, bytes })
}

/** An object's world box on the bed, mm. */
const box = (page: Page, name: string) =>
  page.evaluate((name) => {
    const e = (window as unknown as { __sx: Sx }).__sx.getState().plate.find((p) => p.name === name)!
    const m = e.transform
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (const part of e.parts)
      for (let i = 0; i + 2 < part.positions.length; i += 3) {
        const [x, y, z] = [part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!]
        const w = [0, 1, 2].map((k) => m[k]! * x + m[k + 4]! * y + m[k + 8]! * z + m[k + 12]!)
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, w[k]!)
          max[k] = Math.max(max[k]!, w[k]!)
        }
      }
    return { min, max }
  }, name)

const screen = (page: Page, x: number, y: number, z: number) =>
  page.evaluate(([x, y, z]) => {
    const vp = (window as unknown as { __vp: Vp }).__vp
    const v = vp.camera.position.clone().set(x as number, y as number, z as number).applyMatrix4(vp.stage.bedRoot.matrixWorld).project(vp.camera)
    const r = vp.canvas.getBoundingClientRect()
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
  }, [x, y, z] as const)

/**
 * Where a bed point is on screen once the view has settled for a press. A plate change slices on its own; when that
 * slice lands, the toolpath look's legend, layer strip and playback bar come up over the view and the camera frames
 * the plate again in the space they leave, so a press aimed before then lands somewhere else and turns the view. This
 * waits for the slice to be current, then for the same spot twice, further apart than the view's second look at its
 * overlays (600 ms).
 */
async function aim(page: Page, x: number, y: number, z: number): Promise<{ x: number; y: number }> {
  const sliced = () => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState().slice; return s.status === 'done' && !s.stale })
  await expect.poll(sliced, { timeout: 60_000 }).toBe(true)
  let at = await screen(page, x, y, z)
  await expect
    .poll(async () => {
      const again = await screen(page, x, y, z)
      const still = Math.hypot(again.x - at.x, again.y - at.y) < 0.5
      at = again
      return still
    }, { intervals: [700] })
    .toBe(true)
  return at
}

const lines = (page: Page) => page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.gaps.group.children.map((c) => c.visible))

/** Puts one object's +X side against another's -X side, centered on it in Y. */
async function against(page: Page, mover: string, target: string): Promise<void> {
  const a = await box(page, mover)
  const b = await box(page, target)
  await page.evaluate(({ mover, dx, dy }) => {
    const st = (window as unknown as { __sx: Sx }).__sx
    st.setState({ plate: st.getState().plate.map((p) => (p.name === mover ? { ...p, transform: p.transform.map((v, i) => (i === 12 ? v + dx : i === 13 ? v + dy : v)) } : p)) })
  }, { mover, dx: b.max[0]! - a.min[0]!, dy: (b.min[1]! + b.max[1]!) / 2 - (a.min[1]! + a.max[1]!) / 2 })
}

test('parts of one object that touch never warn; a separate object that touches does, and its marker clears as it moves', { tag: '@gpu' }, async ({ page, isMobile }) => {
  test.skip(isMobile, 'Needs a pointer')
  test.slow()
  await open(page)
  await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await drop(page, 'temperature-tower.sx3mf')
  await expect(page.locator('.obj-name', { hasText: 'Temperature tower' })).toBeVisible({ timeout: 60_000 })
  await drop(page, 'calibration-cube-20mm.sx3mf')
  await expect(page.locator('.obj-name', { hasText: '20 mm calibration cube' })).toBeVisible({ timeout: 60_000 })

  await against(page, '20 mm calibration cube', 'Temperature tower')
  const notes = page.locator('.obj-note')
  await expect(notes).toHaveCount(2, { timeout: 30_000 })
  await expect(notes.nth(0)).toContainText('Touches 20 mm calibration cube, so they will print as one piece')
  await expect(notes.nth(1)).toContainText('Touches Temperature tower, so they will print as one piece')
  await expect(page.getByText(/touch, so they will print as one piece/)).toHaveCount(0)
  await expect.poll(() => lines(page)).toEqual([true])

  // Show which lists the other object.
  await notes.nth(1).getByRole('button', { name: 'Show which' }).click()
  await expect(notes.nth(1).locator('.obj-note-which li')).toHaveText(['Temperature tower, touching'])

  // Drag the cube away: the marker hides with the first move, before the drop.
  const c = await box(page, '20 mm calibration cube')
  const at = await aim(page, (c.min[0]! + c.max[0]!) / 2, (c.min[1]! + c.max[1]!) / 2, c.max[2]! / 2)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(at.x + i * 6, at.y + i * 3)
  await expect.poll(() => lines(page)).toEqual([false])
  await page.mouse.up()
  await expect(notes).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => lines(page)).toEqual([])
})

test('every starter opens alone, with no notes and no markers', { tag: '@gpu' }, async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  const plate = () => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.map((p) => p.name))
  const titles = new Map((JSON.parse(readFileSync(join(starters, 'manifest.json'), 'utf8')) as { listings: { slug: string; title: string }[] }).listings.map((l) => [l.slug, l.title]))
  for (const slug of STARTERS) {
    await openFile(page, `${slug}.sx3mf`)
    await expect.poll(plate, { timeout: 60_000 }).toEqual([titles.get(slug)])
    // The check runs a moment after the plate changes.
    await page.waitForTimeout(2500)
    await expect(page.locator('.obj-note'), slug).toHaveCount(0)
    expect(await lines(page), slug).toEqual([])
  }
})

test('a design whose parts do not touch gets one note, Show which names them, and its marker follows a drag', { tag: '@gpu' }, async ({ page, isMobile }) => {
  test.skip(isMobile, 'Needs a pointer')
  test.slow()
  await open(page)
  await openFixture(page, 'loose-clip.sx3mf')
  await expect(page.locator('.obj-name')).toHaveText(['Cable clip'], { timeout: 60_000 })
  const note = page.locator('.obj-note')
  await expect(note).toHaveCount(1, { timeout: 30_000 })
  await expect(note).toContainText(/Clip and Foot are 0\.\d\d mm apart and do not touch, so they print as separate pieces/)
  await note.getByRole('button', { name: 'Show which' }).click()
  await expect(note.locator('.obj-note-which li')).toHaveText([/^Clip and Foot, 0\.\d\d mm$/])
  await expect.poll(() => lines(page)).toEqual([true])

  // Drag the clip: the marker moves with it, from the first move on.
  const where = () =>
    page.evaluate(() => {
      const vp = (window as unknown as { __vp: Vp }).__vp
      // By its id: the view can also hold the prime tower once the plate is sliced.
      const id = (window as unknown as { __sx: Sx }).__sx.getState().plate[0]!.id
      const o = vp.objects.get(id)!.group.matrixWorld.elements
      const m = vp.gaps.group.children[0]!.children[1]!.matrixWorld.elements
      return { object: [o[12]!, o[13]!, o[14]!], marker: [m[12]!, m[13]!, m[14]!] }
    })
  const before = await where()
  // Press on the foot's top face: the middle of the whole clip is the gap between its pieces.
  const foot = await page.evaluate(() => {
    const e = (window as unknown as { __sx: Sx }).__sx.getState().plate[0]!
    const part = e.parts.find((p) => (p as { name?: string }).name === 'Foot')!
    const m = e.transform
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i + 2 < part.positions.length; i += 3) {
      const [x, y, z] = [part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!]
      const w = [0, 1, 2].map((k) => m[k]! * x + m[k + 4]! * y + m[k + 8]! * z + m[k + 12]!)
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, w[k]!)
        max[k] = Math.max(max[k]!, w[k]!)
      }
    }
    return { x: (min[0]! + max[0]!) / 2, y: (min[1]! + max[1]!) / 2, z: max[2]! }
  })
  // Aimed once the open's own slice is in: before then the press can land on the bed beside the clip.
  const at = await aim(page, foot.x, foot.y, foot.z)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(at.x + i * 6, at.y + i * 3)
  await expect.poll(async () => (await where()).object[0] !== before.object[0]).toBe(true)
  await expect
    .poll(async () => {
      const now = await where()
      return [0, 1, 2].every((k) => Math.abs(now.marker[k]! - before.marker[k]! - (now.object[k]! - before.object[k]!)) < 0.01)
    })
    .toBe(true)
  expect(await lines(page)).toEqual([true])
  await page.mouse.up()
  await expect(note).toHaveCount(1)
})

test('opening a design asks once about unsaved work, and Cancel keeps the plate', { tag: '@gpu' }, async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  await openFile(page, 'cable-clip.sx3mf')
  await expect(page.locator('.obj-name', { hasText: 'Cable clip' })).toBeVisible({ timeout: 60_000 })
  // An edit: a second object added by a drop.
  await drop(page, 'calibration-cube-20mm.sx3mf')
  await expect(page.locator('.obj-name', { hasText: '20 mm calibration cube' })).toBeVisible({ timeout: 60_000 })
  await openFile(page, 'temperature-tower.sx3mf')
  const ask = page.getByRole('dialog')
  await expect(ask).toContainText('open another design')
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('.obj-name')).toHaveText(['Cable clip', '20 mm calibration cube'])
  await openFile(page, 'temperature-tower.sx3mf')
  await page.getByRole('dialog').getByRole('button', { name: "Don't save" }).click()
  await expect(page.locator('.obj-name')).toHaveText(['Temperature tower'], { timeout: 60_000 })
  await page.waitForTimeout(2500)
  expect(await lines(page)).toEqual([])
})

test('moving an object does not rebuild the scene, with a prime tower on the plate', { tag: '@gpu' }, async ({ page, isMobile }) => {
  test.skip(isMobile, 'Needs a pointer')
  test.slow()
  await open(page)
  // A printer with a filament unit, so the two color X gets a prime tower.
  await page.getByTestId('slice-machine-printer').click()
  await page.getByRole('list', { name: 'Choose a printer' }).getByRole('button', { name: /Bay 2/ }).click()
  const sliceId = () => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().slice.result?.id ?? null)
  const current = () => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState().slice; return s.status === 'done' && !s.stale })
  await expect.poll(current, { timeout: 120_000 }).toBe(true)
  const before = await sliceId()
  expect(await page.evaluate(() => Boolean((window as unknown as { __sx: Sx }).__sx.getState().slice.result?.primeTower))).toBe(true)
  await page.evaluate(() => {
    const w = window as unknown as { __vp: Vp; __rebuilds: number }
    w.__rebuilds = 0
    const setPlate = w.__vp.setPlate.bind(w.__vp)
    w.__vp.setPlate = (...a: unknown[]) => {
      w.__rebuilds++
      setPlate(...a)
    }
  })
  const x = await box(page, 'Layered X')
  const at = await screen(page, (x.min[0]! + x.max[0]!) / 2, (x.min[1]! + x.max[1]!) / 2, x.max[2]! / 2)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(at.x - i * 5, at.y + i * 2)
  await page.mouse.up()
  await expect.poll(async () => (await box(page, 'Layered X')).min[0]).not.toBe(x.min[0])
  // The plate slices again on its own (a new slice, current); the tower stays drawn meanwhile and moves without a rebuild.
  await expect.poll(() => page.evaluate((b) => { const s = (window as unknown as { __sx: Sx }).__sx.getState().slice; return s.status === 'done' && !s.stale && s.result?.id !== b }, before), { timeout: 120_000 }).toBe(true)
  expect(await page.evaluate(() => (window as unknown as { __rebuilds: number }).__rebuilds)).toBe(0)
})
