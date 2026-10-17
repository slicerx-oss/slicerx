// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Steps the model journeys share: the test hooks a worker's page needs, files opened and dropped on it, the Model view
// framed on a box with the camera still, and the plate picker's layout checks. The journey page boots once per worker, so
// everything here sets the page up again for the test that calls it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { bounds, command, freshBox } from '../../cad-helpers'
import { expectFileDialog, interceptFileDialogs } from '../../file-dialog'
import { expect, pnpmSync, viewportReady } from '../../fixtures'
import { journey as test } from '../../journey'
import { plateProject } from '../../plate-project'

export type V3 = [number, number, number]

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..', '..')

type Store = { getState(): Record<string, unknown>; setState(p: unknown): void }
/** Merges a patch into the app's store. */
export const setState = (page: Page, patch: Record<string, unknown>): Promise<void> => page.evaluate((p) => (window as unknown as { __sx: Store }).__sx.setState(p), patch)

// ---------------------------------------------------------------------------------------------------------------------
// Hooks and flags
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Sets the local-storage flags a test needs and loads the page again when any of them was different. `slicerx.debug`
 * is always among them (it puts the store `__sx` and the view `__vp` on the window) and journey.ts already sets it before
 * every load, so only a flag that differs from the page's costs a reload. A value of null removes the flag. The host
 * reads `slicerx.e2e.cadOnly` once at start, which is why it takes a reload too.
 */
export async function setFlags(page: Page, flags: Record<string, string | null> = {}): Promise<void> {
  const want: Record<string, string | null> = { 'slicerx.debug': '1', ...flags }
  const differs = await page.evaluate((w) => Object.entries(w).some(([k, v]) => localStorage.getItem(k) !== v), want)
  if (!differs) return
  await page.evaluate((w) => {
    for (const [k, v] of Object.entries(w)) {
      if (v === null) localStorage.removeItem(k)
      else localStorage.setItem(k, v)
    }
  }, want)
  await page.reload()
  await viewportReady(page)
}

/** Whether this run is the phone project; a hook of a desktop-only file does nothing there. */
export const onPhone = (): boolean => Boolean(test.info().project.use.isMobile)

/** Before every test of the file (or of the describe it is called in): the flags in place (see `setFlags`). A desktop file skips the phone project; a phone file passes `phone`. */
export function useFlags(flags: Record<string, string | null> = {}, phone = false): void {
  test.beforeEach(async ({ app }) => {
    if (onPhone() !== phone) return
    await setFlags(app, flags)
  })
}

/** Starts listening for file dialogs once for the worker's page, long before the first Open. */
export function useFileDialogs(phone = false): void {
  test.beforeAll(({ app }) => {
    if (onPhone() === phone) interceptFileDialogs(app)
  })
}

/**
 * Before every test of the file: the Slice tab with no Model tool open, which is where the file-open steps look for the
 * objects they open. A Model journey on the same worker leaves its tab and its tool behind.
 */
export function useSliceTab(): void {
  test.beforeEach(async ({ app }) => {
    if (onPhone()) return
    await setState(app, { workspace: 'prepare', objectTool: null, parked: null, historyEdit: null, rollback: null })
    const tab = app.locator('.sx-tab[data-mode="slice"]')
    if ((await tab.count()) && (await tab.getAttribute('aria-current')) !== 'page') await tab.click()
    await expect(tab).toHaveAttribute('aria-current', 'page')
  })
}

/**
 * The Vault's starter files, made by the same generator the Vault uses, the first time a step asks for them, and
 * removed after the file's run. They are made inside the step (not in a beforeAll) so a machine that cannot run the
 * generator fails the steps that need the starters, not the whole file.
 */
export function useStarters(): () => string {
  let dir = ''
  test.afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })
  return () => {
    if (!dir) {
      dir = mkdtempSync(join(tmpdir(), 'sx-starters-'))
      pnpmSync(['--filter', '@slicerx/store', 'exec', 'tsx', '../app/scripts/vault-starters.ts', dir], repoRoot)
    }
    return dir
  }
}

/** A temp folder for files a spec makes, removed after the file's run. */
export function useTempDir(prefix: string): () => string {
  let dir = ''
  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), prefix))
  })
  test.afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })
  return () => dir
}

// ---------------------------------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------------------------------

/** A binary STL of 20 mm cubes 50 mm apart, one per count: one file, a body per cube. Written into `dir`. */
export function cubes(dir: string, name: string, count: number): string {
  const tris: number[][] = []
  for (let c = 0; c < count; c++) {
    const v = (x: number, y: number, z: number) => [c * 50 + x * 20, y * 20, z * 20]
    const quad = (a: number[], b: number[], d: number[], e: number[]) => tris.push([...a, ...b, ...d], [...a, ...d, ...e])
    quad(v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0))
    quad(v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1))
    quad(v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1))
    quad(v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0))
    quad(v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0))
    quad(v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1))
  }
  const buf = Buffer.alloc(84 + tris.length * 50)
  buf.writeUInt32LE(tris.length, 80)
  tris.forEach((t, i) => t.forEach((n, k) => buf.writeFloatLE(n, 84 + i * 50 + 12 + k * 4)))
  const file = join(dir, name)
  writeFileSync(file, buf)
  return file
}

/** A file given to a file dialog: a path, or a name with its bytes. */
export type Pick = string | { name: string; mimeType: string; buffer: Buffer }

/**
 * Open (Ctrl+O) and answer its dialog with `file`. Open starts a new project, so an unsaved one asks first: see `settleOpen`.
 * The shortcut rests while a text field has the focus (a tool's size box the step before typed in), so focus leaves it first.
 */
export async function openFile(page: Page, file: Pick): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const chooser = await expectFileDialog(page, () => page.keyboard.press('ControlOrMeta+o'))
  await chooser.setFiles(file)
}

/**
 * Waits until `done` holds, answering the questions an open can ask on the way: "Save changes first?" gets Don't save
 * (what is open at the start of a journey step is whatever the step before left, saved or not), and with `asProject` the
 * "open as a project or as geometry" question gets the whole project.
 */
export async function settleOpen(page: Page, done: () => Promise<boolean>, opts: { asProject?: boolean; timeout?: number } = {}): Promise<void> {
  await expect
    .poll(
      async () => {
        const discard = page.getByTestId('unsaved-discard')
        if (await discard.isVisible()) {
          await discard.click()
          return false
        }
        const whole = page.getByTestId('project-open-as-project')
        if (opts.asProject && (await whole.isVisible())) {
          await whole.click()
          return false
        }
        return done()
      },
      { timeout: opts.timeout ?? 60_000, intervals: [200, 300, 500] },
    )
    .toBe(true)
}

/** A drop of a file on the window adds it to the plate. */
export async function dropFile(page: Page, name: string, bytes: Buffer | Uint8Array, type = ''): Promise<void> {
  const data = [...bytes]
  await page.evaluate(({ name, data, type }) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(data)], name, { type }))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, { name, data, type })
}

/** A drop of a file from the starters folder (or any path). */
export const dropPath = (page: Page, path: string, name = path.split('/').pop()!): Promise<void> => dropFile(page, name, readFileSync(path))

/** Back to the example plate (Layered X) on the Slice tab, with nothing else on it. */
export async function examplePlate(page: Page): Promise<void> {
  const slice = page.locator('.sx-tab[data-mode="slice"]')
  if (await slice.count()) await slice.click()
  // Starting over replaces the shown plate's objects only; a new project first takes the other plates away.
  await command(page, 'New project')
  await settleOpen(page, () =>
    page.evaluate(() => {
      const s = (window as unknown as { __sx: { getState(): { plates: unknown[]; plate: unknown[]; plateLoading: boolean } } }).__sx.getState()
      return !s.plateLoading && s.plates.length === 1 && s.plate.length === 0
    }),
  )
  await command(page, 'Start over with the example plate')
  const summary = () =>
    page.evaluate(() => {
      const s = (window as unknown as { __sx: { getState(): { plates: unknown[]; plate: { name: string }[]; plateLoading: boolean } } }).__sx.getState()
      return { loading: s.plateLoading, plates: s.plates.length, objects: s.plate.map((p) => p.name) }
    })
  try {
    await settleOpen(page, async () => {
      const s = await summary()
      return !s.loading && s.plates === 1 && s.objects.length === 1 && s.objects[0] === 'Layered X'
    })
  } catch (e) {
    throw new Error(`the example plate did not come back: ${JSON.stringify(await summary())}; dialogs: ${await page.getByRole('dialog').count()}`, { cause: e })
  }
  await expect(page.locator('.obj-name', { hasText: 'Layered X' })).toBeVisible()
}

/** Open (Ctrl+O) with `file`, answering the unsaved-work question, and waits until new objects are on the plate and it has loaded. */
export async function openModel(page: Page, file: Pick, opts: { asProject?: boolean } = {}): Promise<void> {
  type S = { getState(): { plate: { id: string }[]; plateLoading: boolean } }
  const before = await page.evaluate(() => (window as unknown as { __sx: S }).__sx.getState().plate.map((p) => p.id))
  await openFile(page, file)
  await settleOpen(
    page,
    () =>
      page.evaluate((was) => {
        const s = (window as unknown as { __sx: S }).__sx.getState()
        return !s.plateLoading && s.plate.length > 0 && !s.plate.some((p) => was.includes(p.id))
      }, before),
    opts,
  )
}

/** Every object on every plate, by id: the shown plate's are `plate`, the others' are in `plates`. */
const allObjectIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const s = (window as unknown as { __sx: { getState(): { plates: { id: string; objects: { id: string }[] }[]; plate: { id: string }[]; activePlate: string } } }).__sx.getState()
    return s.plates.flatMap((p) => (p.id === s.activePlate ? s.plate : p.objects).map((o) => o.id))
  })

/**
 * Opens a project of `names.length` plates (plate-project.ts) through Open and waits until all its plates are in and
 * none of the objects on them are the ones that were open before: plate ids are the same from project to project.
 */
export async function openPlates(page: Page, names: readonly string[], empty: readonly number[] = [], opts: { asProject?: boolean } = {}): Promise<void> {
  type S = { getState(): { plates: unknown[]; plateLoading: boolean } }
  const before = await allObjectIds(page)
  await openFile(page, { name: 'Deck box.3mf', mimeType: 'model/3mf', buffer: plateProject(names, empty) })
  await settleOpen(
    page,
    async () => {
      const s = await page.evaluate(() => { const st = (window as unknown as { __sx: S }).__sx.getState(); return { loading: st.plateLoading, plates: st.plates.length } })
      if (s.loading || s.plates !== names.length) return false
      const now = await allObjectIds(page)
      return now.length === names.length - empty.length && !now.some((id) => before.includes(id))
    },
    opts,
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// The Model view
// ---------------------------------------------------------------------------------------------------------------------

type Vp = {
  screenOf(p: number[]): [number, number]
  drawnObjects(): string[]
  rig: { move: unknown }
  view(v: string, o?: unknown): void
}

/** A bed point (mm) on screen, in client pixels. */
export const bedToScreen = (page: Page, p: V3): Promise<[number, number]> => page.evaluate((p) => (window as unknown as { __vp: Vp }).__vp.screenOf(p), p)

/** Waits until the view's frame stops moving: the same spot four reads in a row, with no camera move running (a pane opening resizes it a little later). */
export async function settledView(page: Page): Promise<void> {
  let last = ''
  let still = 0
  await expect
    .poll(async () => {
      const now = (await bedToScreen(page, [0, 0, 0])).map((v) => Math.round(v)).join(',')
      const moving = await page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.rig.move !== null)
      still = now === last && !moving ? still + 1 : 0
      last = now
      return still >= 4
    }, { intervals: [250], timeout: 15_000 })
    .toBe(true)
}

/**
 * Frames the view on the objects once it draws them and its camera has stopped. The view swaps a new plate in a frame
 * after the store has it, and Model opens with an eased move to its own view that a slow machine draws slowly: a fit
 * keeps the camera's angle, so one taken partway through that move frames from another angle on every run.
 */
export async function fitView(page: Page, ids: string[], pill = true): Promise<void> {
  await expect.poll(() => page.evaluate((ids) => ids.every((id) => (window as unknown as { __vp: Vp }).__vp.drawnObjects().includes(id)), ids)).toBe(true)
  if (pill) await expect(filter(page, 'face')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.rig.move === null)).toBe(true)
  await page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.view('fit', { animate: false }))
  await settledView(page)
}

/** Model's pick filter button by kind: face, edge or object. */
export const filter = (page: Page, kind: string): Locator => page.locator(`[data-testid="model-select-filter"][data-kind="${kind}"]`)

/** Faces and edges picked so far, by kind. */
export const subPicks = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __sx: { getState(): { subPicks: { kind: string }[] } } }).__sx.getState().subPicks.map((p) => p.kind))

/** A step starts from an empty Model: no tool open, nothing picked, the right pane shown, the default pick filter. */
export async function modelReset(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sx = (window as unknown as { __sx: { getState(): { rails: Record<string, Record<string, boolean>> }; setState(p: unknown): void } }).__sx
    const rails = sx.getState().rails
    sx.setState({ plate: [], selection: null, selectedIds: [], subPicks: [], objectTool: null, pickFilter: ['face'], rails: { ...rails, 'prepare-design': { ...rails['prepare-design'], right: true } } })
  })
}

/** Model on a fresh 20 mm box, drawn and framed, with the camera still. Returns the box's id. */
export async function framedBox(page: Page): Promise<string> {
  await modelReset(page)
  const id = await freshBox(page)
  await page.locator('.sx-tab[data-mode="design"]').click()
  await fitView(page, [id])
  return id
}

type Sx = { getState(): { plate: { id: string; transform: number[] }[] }; setState(p: unknown): void }

/**
 * A second box right behind the first and three times as tall, so a ray through the first one's top reaches the
 * second one's front face. `add` adds a box to the plate; the plate holds one already. Returns both ids, front first.
 */
export async function twoBoxes(page: Page, add: () => Promise<void>): Promise<{ front: string; back: string }> {
  await add()
  const ids = () => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.getState().plate.map((p) => p.id))
  await expect.poll(async () => (await ids()).length).toBe(2)
  const [front, back] = (await ids()) as [string, string]
  const b = await bounds(page, front)
  await page.evaluate(
    ({ front, back, depth }) => {
      const sx = (window as unknown as { __sx: Sx }).__sx
      const plate = sx.getState().plate
      const t = [...plate.find((p) => p.id === front)!.transform]
      t[13] = t[13]! + depth
      for (const k of [8, 9, 10]) t[k] = t[k]! * 3
      sx.setState({ plate: plate.map((p) => (p.id === back ? { ...p, transform: t } : p)), selection: null, selectedIds: [], subPicks: [] })
    },
    { front, back, depth: b.max[1] - b.min[1] + 2 },
  )
  return { front, back }
}

/** A spot whose nearest thing is the front box's top face, well clear of its edges, with the back box behind it. */
export async function stackedSpot(page: Page, front: string, back: string): Promise<{ x: number; y: number }> {
  const spot = await page.evaluate(
    ({ front, back }) => {
      type Hit = { objectId: string; normal: number[] }
      const vp = (window as unknown as { __vp: { pickAll(x: number, y: number): Hit[]; canvas: HTMLCanvasElement } }).__vp
      const r = vp.canvas.getBoundingClientRect()
      const ok = (x: number, y: number) => {
        const h = vp.pickAll(x, y)
        return h[0]?.objectId === front && (h[0]?.normal[2] ?? 0) > 0.9 && h.some((k) => k.objectId === back)
      }
      // the spot and a ring 14 px around it all on the same stack: well inside the face, away from its edges
      for (let y = r.top + 8; y < r.bottom - 8; y += 6)
        for (let x = r.left + 8; x < r.right - 8; x += 6) if (ok(x, y) && [[14, 0], [-14, 0], [0, 14], [0, -14]].every(([dx, dy]) => ok(x + dx!, y + dy!))) return { x, y }
      return null
    },
    { front, back },
  )
  expect(spot, 'a spot on the front box with the back box behind it').not.toBeNull()
  return spot!
}

/** Shuts the right pane, as a person does with its edge tab. */
export const shutRightPane = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const sx = (window as unknown as { __sx: { getState(): { rails: Record<string, Record<string, boolean>> }; setState(p: unknown): void } }).__sx
    const rails = sx.getState().rails
    sx.setState({ rails: { ...rails, 'prepare-design': { ...rails['prepare-design'], right: false } } })
  })

/**
 * The screen point `px` pixels inside the box's top face from the middle of its front top edge, measured square to
 * that edge on screen: the pick radius is a distance from the edge, and the top face is foreshortened, so a step
 * toward the face's center would land nearer the edge than its length.
 */
export async function nearFrontEdge(page: Page, b: { min: V3; max: V3 }, px: number): Promise<{ x: number; y: number }> {
  const ends: [V3, V3] = [[b.min[0], b.min[1], b.max[2]], [b.max[0], b.min[1], b.max[2]]]
  const center: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]]
  return page.evaluate(
    ({ ends, center, px }) => {
      const vp = (window as unknown as { __vp: Vp }).__vp
      const a = vp.screenOf(ends[0])
      const e = vp.screenOf(ends[1])
      const c = vp.screenOf(center)
      const m: [number, number] = [(a[0] + e[0]) / 2, (a[1] + e[1]) / 2]
      const len = Math.hypot(e[0] - a[0], e[1] - a[1])
      // the edge's normal on screen, turned toward the face
      let n: [number, number] = [-(e[1] - a[1]) / len, (e[0] - a[0]) / len]
      if (n[0] * (c[0] - m[0]) + n[1] * (c[1] - m[1]) < 0) n = [-n[0], -n[1]]
      return { x: m[0] + n[0] * px, y: m[1] + n[1] * px }
    },
    { ends, center, px },
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// The plate picker
// ---------------------------------------------------------------------------------------------------------------------

export type Box = { x: number; y: number; width: number; height: number }

export const picker = (page: Page): Locator => page.getByTestId('plate-picker')
export const current = (page: Page): Locator => page.getByTestId('plate-picker-current')
export const prev = (page: Page): Locator => page.getByTestId('plate-picker-prev')
export const next = (page: Page): Locator => page.getByTestId('plate-picker-next')

/** The plate shown, from 1. */
export const shown = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const s = (window as unknown as { __sx: { getState(): { plates: { id: string }[]; activePlate: string } } }).__sx.getState()
    return s.plates.findIndex((p) => p.id === s.activePlate) + 1
  })

/** The boxes of the picker's controls, rounded, for checking that nothing moved. */
export async function pickerBoxes(page: Page): Promise<Box[]> {
  const out: Box[] = []
  for (const l of [picker(page), prev(page), current(page), next(page)]) {
    const b = (await l.boundingBox())!
    out.push({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) })
  }
  return out
}

const apart = (a: Box, b: Box) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y

/** The picker is one row: one control tall, inside the view, and clear of the toolbar's lane at the top. */
export async function oneRowClearOfLane(page: Page, also?: Locator): Promise<void> {
  const row = (await picker(page).boundingBox())!
  expect(row.height).toBeLessThanOrEqual(48)
  const vp = (await page.locator('.vp').boundingBox())!
  expect(row.x).toBeGreaterThanOrEqual(vp.x)
  expect(row.x + row.width).toBeLessThanOrEqual(vp.x + vp.width + 0.5)
  expect(row.y + row.height).toBeLessThanOrEqual(vp.y + vp.height + 0.5)
  const lane = page.locator('.plate-tools-group')
  if (await lane.count()) {
    const l = (await lane.boundingBox())!
    expect(apart(row, l), `picker ${JSON.stringify(row)} lane ${JSON.stringify(l)}`).toBe(true)
    if (also) {
      const s = (await also.boundingBox())!
      expect(apart(s, l), `sheet ${JSON.stringify(s)} lane ${JSON.stringify(l)}`).toBe(true)
      expect(s.y).toBeGreaterThanOrEqual(l.y + l.height)
    }
  }
}
