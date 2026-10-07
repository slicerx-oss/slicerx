// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The fit check on the Vault's starters, made by the same generator: parts of one design that touch never warn, the
// cable clip's ring that floats off its foot does, a separate object that touches warns and its marker goes the
// moment it is dragged away. Opening a design starts a new project, so designs never pile up. Moving an object
// never rebuilds the scene.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { plateReady, viewportReady } from './fixtures'

type Entry = { id: string; name: string; transform: number[]; parts: { positions: ArrayLike<number> }[] }
type Sx = { getState(): { plate: Entry[]; slice: { status: string; stale?: boolean; result?: { primeTower?: unknown } } }; setState(p: unknown): void }
const STARTERS = ['x-mark', 'calibration-cube-20mm', 'wall-hook', 'shelf-bracket', 'first-layer-test', 'overhang-test', 'bridging-test', 'retraction-test', 'temperature-tower', 'cable-clip']
interface Vp {
  camera: { position: { clone(): { set(x: number, y: number, z: number): { applyMatrix4(m: unknown): { project(c: unknown): { x: number; y: number } } } } } }
  stage: { bedRoot: { matrixWorld: unknown } }
  canvas: HTMLCanvasElement
  gaps: { group: { children: { visible: boolean }[] } }
  setPlate(...a: unknown[]): void
}

const root = join(import.meta.dirname, '..', '..', '..')
let starters = ''

test.beforeAll(() => {
  // The starters are made in code; the output never goes in git.
  starters = mkdtempSync(join(tmpdir(), 'sx-starters-'))
  execFileSync('pnpm', ['--filter', '@slicerx/store', 'exec', 'tsx', '../app/scripts/vault-starters.ts', starters], { cwd: root, stdio: 'ignore' })
})

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', sliceLook: 'toolpaths', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await viewportReady(page)
}

/** Open (Mod+O): a new project with the file. */
async function openFile(page: Page, file: string): Promise<void> {
  // A key pressed while the page is still settling can be lost, so it is pressed again until the file dialog opens.
  await expect(async () => {
    const chooser = page.waitForEvent('filechooser', { timeout: 5_000 })
    await page.keyboard.press('ControlOrMeta+o')
    await (await chooser).setFiles(join(starters, file))
  }).toPass({ timeout: 60_000 })
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

test('parts of one object that touch never warn; a separate object that touches does, and its marker clears as it moves', async ({ page, isMobile }) => {
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
  const at = await screen(page, (c.min[0]! + c.max[0]!) / 2, (c.min[1]! + c.max[1]!) / 2, c.max[2]! / 2)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(at.x + i * 6, at.y + i * 3)
  await expect.poll(() => lines(page)).toEqual([false])
  await page.mouse.up()
  await expect(notes).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => lines(page)).toEqual([])
})

test('opening starters one after another: one design on the plate, its own notes only, never notes for parts that touch', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  const plate = () => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.map((p) => p.name))
  const titles = new Map((JSON.parse(readFileSync(join(starters, 'manifest.json'), 'utf8')) as { listings: { slug: string; title: string }[] }).listings.map((l) => [l.slug, l.title]))
  for (const slug of STARTERS.slice(0, -1)) {
    await openFile(page, `${slug}.sx3mf`)
    await expect.poll(plate, { timeout: 60_000 }).toEqual([titles.get(slug)])
    // The check runs a moment after the plate changes; parts that touch never get a note.
    await page.waitForTimeout(2500)
    await expect(page.locator('.obj-note'), slug).toHaveCount(0)
    expect(await lines(page), slug).toEqual([])
  }
  // The cable clip's ring floats 0.76 mm off its foot in the seeded file: it prints as two loose pieces.
  await openFile(page, 'cable-clip.sx3mf')
  await expect.poll(plate, { timeout: 60_000 }).toEqual(['Cable clip'])
  await expect(page.locator('.obj-note')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator('.obj-note')).toContainText(/Clip and Foot are 0\.\d\d mm apart and do not touch, so they print as separate pieces/)
  await expect.poll(() => lines(page)).toEqual([true])
})

test('opening a design asks once about unsaved work, and Cancel keeps the plate', async ({ page, isMobile }) => {
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

test('moving an object does not rebuild the scene, with a prime tower on the plate', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Needs a pointer')
  test.slow()
  await open(page)
  // A printer with a filament unit, so the two color X gets a prime tower.
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await page.getByRole('list', { name: 'Choose a printer' }).getByRole('button', { name: /Bay 2/ }).click()
  const current = () => page.evaluate(() => { const s = (window as unknown as { __sx: Sx }).__sx.getState().slice; return s.status === 'done' && !s.stale })
  await expect.poll(current, { timeout: 120_000 }).toBe(true)
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
  // The plate slices again on its own; the tower stays drawn meanwhile and moves without a rebuild.
  await expect.poll(current, { timeout: 120_000 }).toBe(true)
  expect(await page.evaluate(() => (window as unknown as { __rebuilds: number }).__rebuilds)).toBe(0)
})
