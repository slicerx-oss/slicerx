// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pressing a radio, a segmented option, a select, a checkbox, a switch, a tab or a section header never moves
// anything: the pressed control, and everything before it in its panel, stay put to half a pixel. New content opens
// below. Each screen's controls are pressed one by one and measured before and after.
import { mkdirSync, writeFileSync } from 'node:fs'
import { type Locator, type Page, type TestInfo } from '@playwright/test'
import { expect, openSheet, plateReady, test } from './fixtures'

type Sx = { setState(p: unknown): void }
type Moved = { control: string; what: string; dx: number; dy: number; dw: number; dh: number }

/** Every control the rule covers. Buttons that open a menu or a dialog are left out: they move nothing in place. */
const CONTROLS = [
  '[role="radio"]',
  '[role="tab"]',
  '[role="switch"]',
  'input[type="checkbox"]',
  'select',
  // A panel's edge tab shuts the whole panel: it is meant to move things, and is left out.
  'button[aria-expanded]:not([aria-haspopup]):not(.sx-edge-tab)',
  '.settings-nav button',
].join(', ')

const LIMIT = 0.5
const MAX_PER_SCREEN = 40

async function open(page: Page, prefs: Record<string, unknown>): Promise<void> {
  await page.addInitScript((p) => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' }, printerId: 'bay-1', ...p }))
  }, prefs)
  await page.goto('./')
  await plateReady(page)
}

const sx = (page: Page, p: unknown) => page.evaluate((x) => (window as unknown as { __sx: Sx }).__sx.setState(x), p)

/**
 * Waits for the view to come to rest: no transition or animation running in it, the camera not moving, and the view's
 * overlays and camera the same across two frames. On a busy machine a style change (the timeline shutting) can wait
 * for the next frame before its transition even starts, so a fixed pause can measure the old place, or halfway.
 * Reading the animations flushes styles, which starts any transition still pending.
 */
async function viewAtRest(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const vp = (window as unknown as { __vp: { camera: { position: { x: number; y: number; z: number } }; stats(): { cameraMoving: boolean } } }).__vp
        const view = document.querySelector('.vp')
        if (!view) return false
        const busy = () => view.getAnimations({ subtree: true }).some((a) => a.playState !== 'finished' && a.effect?.getTiming().iterations !== Infinity)
        const look = () => {
          const p = vp.camera.position
          const rects = [...view.querySelectorAll('.mimir-lookups, .mimir-lookup, .hud-bl > *')].map((e) => e.getBoundingClientRect())
          return JSON.stringify([p.x, p.y, p.z, rects.map((r) => [r.x, r.y, r.width, r.height])])
        }
        if (busy() || vp.stats().cameraMoving) return false
        const a = look()
        const frame = () => new Promise((r) => requestAnimationFrame(r))
        await frame()
        await frame()
        return !busy() && !vp.stats().cameraMoving && look() === a
      }),
    )
    .toBe(true)
}

/**
 * Boxes of the control and of what comes before it: at each level from the control up to the screen's root, the
 * element's earlier siblings. Marked with data attributes, so they can be found again after the press.
 */
async function measure(control: Locator, root: Locator): Promise<Record<string, { x: number; y: number; w: number; h: number }>> {
  return control.evaluate((el, rootEl) => {
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {}
    const box = (e: Element) => {
      const r = e.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }
    // Ids are unique for the page's life, so a box found again is the same element.
    const w = window as unknown as { __lsN?: number }
    const tag = (e: Element) => {
      const id = e.getAttribute('data-ls') ?? `ls${(w.__lsN = (w.__lsN ?? 0) + 1)}`
      e.setAttribute('data-ls', id)
      return id
    }
    out['control'] = box(el)
    for (let at: Element | null = el; at && at !== rootEl && Object.keys(out).length < 40; at = at.parentElement) {
      for (let s = at.previousElementSibling; s && Object.keys(out).length < 40; s = s.previousElementSibling) {
        const b = box(s)
        if (b.w < 1 || b.h < 1) continue
        // keyed by id and a short name, so a report says what moved
        out[`${tag(s)} ${s.tagName.toLowerCase()}${s.classList.length ? `.${Array.from(s.classList).slice(0, 2).join('.')}` : ''}`] = b
      }
    }
    return out
  }, await root.elementHandle())
}

async function remeasure(page: Page, control: Locator, keys: string[]): Promise<Record<string, { x: number; y: number; w: number; h: number } | null>> {
  const own = await control.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }).catch(() => null)
  const rest = await page.evaluate((ids) => {
    const out: Record<string, { x: number; y: number; w: number; h: number } | null> = {}
    for (const id of ids) {
      const e = document.querySelector(`[data-ls="${id.split(' ')[0]}"]`)
      if (!e) {
        out[id] = null
        continue
      }
      const r = e.getBoundingClientRect()
      out[id] = { x: r.x, y: r.y, w: r.width, h: r.height }
    }
    return out
  }, keys.filter((k) => k !== 'control'))
  return { control: own, ...rest }
}

async function label(control: Locator): Promise<string> {
  return control.evaluate((el) => {
    const name = el.getAttribute('aria-label') ?? el.getAttribute('data-testid') ?? el.textContent ?? ''
    const role = el.getAttribute('role') ?? el.tagName.toLowerCase()
    return `${role} "${name.trim().replace(/\s+/g, ' ').slice(0, 40)}"`
  })
}

/** Presses one control the way a person would: a click, or for a select another option. */
async function press(page: Page, control: Locator): Promise<boolean> {
  const tag = await control.evaluate((el) => el.tagName.toLowerCase())
  if (tag === 'select') {
    const next = await control.evaluate((el) => {
      const s = el as HTMLSelectElement
      const opts = Array.from(s.options).filter((o) => !o.disabled && o.value !== s.value)
      return opts[0]?.value ?? null
    })
    if (next === null) return false
    await control.selectOption(next)
    return true
  }
  await control.click({ timeout: 3000 })
  return true
}

/** Presses every covered control in `root`, one at a time, and lists what moved. */
async function probe(page: Page, screen: string, root: Locator): Promise<Moved[]> {
  const moved: Moved[] = []
  const count = Math.min(await root.locator(CONTROLS).count(), MAX_PER_SCREEN)
  for (let i = 0; i < count; i++) {
    const control = root.locator(CONTROLS).nth(i)
    if (!(await control.isVisible().catch(() => false)) || !(await control.isEnabled().catch(() => false))) continue
    await control.scrollIntoViewIfNeeded().catch(() => undefined)
    // Scrolling into view can stop half a pixel into a pane, which a wheel or a finger at 1x never does; a scroll
    // back to that half pixel rounds, so the pane is set on a whole pixel first.
    await control.evaluate((el) => {
      for (let p = el.parentElement; p; p = p.parentElement) if (p.scrollTop % 1) p.scrollTop = Math.round(p.scrollTop)
    })
    const name = await label(control)
    const before = await measure(control, root)
    const pressed = await press(page, control).catch(() => false)
    if (!pressed) continue
    await page.waitForTimeout(350)
    const after = await remeasure(page, control, Object.keys(before))
    // Text size and font weight restyle every text on screen, the pressed option with it. They are exempt from the
    // half pixel, but the pressed option must still be under the pointer: the middle of its old box is inside the new.
    const restyles = await control.evaluate((el) => Boolean(el.closest('[role="radiogroup"][aria-label="Text size"], [role="radiogroup"][aria-label="Font weight"]')))
    if (restyles) {
      const b = before['control']!
      const a = after['control']
      const x = b.x + b.w / 2
      const y = b.y + b.h / 2
      if (!a || x < a.x || x > a.x + a.w || y < a.y || y > a.y + a.h) moved.push({ control: `${screen}: ${name}`, what: 'control, off the pointer', dx: a ? a.x - b.x : NaN, dy: a ? a.y - b.y : NaN, dw: a ? a.w - b.w : NaN, dh: a ? a.h - b.h : NaN })
      continue
    }
    for (const [k, b] of Object.entries(before)) {
      const a = after[k]
      if (!a) continue
      // The control keeps its whole box; what comes before it keeps its place and width (its far edge may move only
      // as text inside it changes, which moves nothing else).
      const d = { dx: a.x - b.x, dy: a.y - b.y, dw: a.w - b.w, dh: k === 'control' ? a.h - b.h : 0 }
      if (Math.max(...Object.values(d).map(Math.abs)) > LIMIT) moved.push({ control: `${screen}: ${name}`, what: k, ...d })
    }
    // A press that opened a menu or popover is closed again before the next one.
    if (await page.locator('[role="menu"]').count()) await page.keyboard.press('Escape')
  }
  return moved
}

function report(info: TestInfo, moved: Moved[]): void {
  const dir = info.outputPath('layout')
  mkdirSync(dir, { recursive: true })
  const lines = moved.map((m) => `${m.control} moved ${m.what} by x ${m.dx.toFixed(1)} y ${m.dy.toFixed(1)} w ${m.dw.toFixed(1)} h ${m.dh.toFixed(1)}`)
  writeFileSync(`${dir}/moved.txt`, lines.join('\n'))
  console.log(lines.length ? lines.join('\n') : 'nothing moved')
}

test.describe('controls never move when pressed', () => {
  test('Slice in Simple', async ({ page }, info) => {
    await open(page, { settingsMode: 'simple' })
    await openSheet(page)
    const moved = await probe(page, 'Slice Simple', page.locator('aside.pane[data-side="left"]'))
    report(info, moved)
    expect(moved).toEqual([])
  })

  test('a control half under the sidebar\'s footer stays where it was pressed', async ({ page, isMobile }) => {
    test.skip(isMobile, 'The sidebar is a sheet on a phone')
    // a short window, so the settings scroll
    await page.setViewportSize({ width: 1440, height: 700 })
    await open(page, { settingsMode: 'simple' })
    // The pane scrolled so Supports sits half under the bottom edge of the scroller, above the footer.
    const body = page.locator('aside.pane[data-side="left"] .sx-rail-body')
    const auto = page.getByRole('radiogroup', { name: 'Supports' }).getByRole('radio', { name: 'Auto' })
    await auto.evaluate((radio) => {
      const box = radio.closest('.sx-rail-body')!
      const r = radio.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      box.scrollTop = Math.round(box.scrollTop + r.top + r.height / 2 - b.bottom)
    })
    const before = (await auto.boundingBox())!.y
    const scroller = (await body.boundingBox())!
    expect(before + (await auto.boundingBox())!.height).toBeGreaterThan(scroller.y + scroller.height)
    // the mouse, not a locator click, which would scroll the radio into view itself first
    const r = (await auto.boundingBox())!
    await page.mouse.click(r.x + r.width / 2, r.y + 4)
    await expect(auto).toHaveAttribute('aria-checked', 'true')
    await page.waitForTimeout(350)
    expect(Math.abs((await auto.boundingBox())!.y - before)).toBeLessThanOrEqual(0.5)
  })

  test('Slice in Advanced, with every setting group open', async ({ page }, info) => {
    test.slow()
    await open(page, { settingsMode: 'advanced' })
    await openSheet(page)
    await sx(page, { expertOpen: true })
    const moved = await probe(page, 'Slice Advanced', page.locator('aside.pane[data-side="left"]'))
    report(info, moved)
    expect(moved).toEqual([])
  })

  test('Model panels', async ({ page, isMobile }, info) => {
    test.skip(isMobile, 'The Model panels are sheets on a phone; covered at desktop width')
    await open(page, { settingsMode: 'advanced' })
    await page.locator('.sx-tab[data-mode="design"]').click()
    await expect(page.getByTestId('model-tree')).toBeVisible()
    const moved = [...(await probe(page, 'Model tree', page.locator('aside.pane[data-side="left"]'))), ...(await probe(page, 'Model inspector', page.locator('aside.pane[data-side="right"]')))]
    report(info, moved)
    expect(moved).toEqual([])
  })

  test('the mimir tab', async ({ page, isMobile }, info) => {
    test.skip(isMobile, 'Phones have no modeling tabs')
    await open(page, { settingsMode: 'advanced' })
    // Pressing the tab moves nothing in the bar: the tabs, the project name and the buttons on the right.
    const boxes = () => page.locator('.sx-appbar').locator('.sx-tab, .sx-projname, .sx-btn').evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }))
    const before = await boxes()
    await page.getByTestId('tab-mimir').click()
    await expect(page.getByTestId('mimir-chat')).toBeVisible()
    await page.waitForTimeout(350)
    const after = await boxes()
    expect(after.length).toBe(before.length)
    const moved: Moved[] = []
    after.forEach((a, i) => {
      const b = before[i]!
      const d = { dx: a.x - b.x, dy: a.y - b.y, dw: a.w - b.w, dh: a.h - b.h }
      if (Math.max(...Object.values(d).map(Math.abs)) > LIMIT) moved.push({ control: 'tab-mimir', what: `top bar item ${i}`, ...d })
    })
    moved.push(...(await probe(page, 'mimir chat', page.getByTestId('mimir-chat'))))
    report(info, moved)
    expect(moved).toEqual([])
  })

  test('mimir lookup cards', async ({ page, isMobile }, info) => {
    test.skip(isMobile, 'Phones have no modeling tabs')
    test.slow()
    await open(page, { settingsMode: 'advanced' })
    await sx(page, { plate: [], selection: null, selectedIds: [] })
    await page.getByTestId('tab-mimir').click()
    const composer = page.getByTestId('mimir-composer')
    const timeline = page.locator('.bpanel-body')
    const cards = page.getByTestId('mimir-lookup-card')
    // Three backplates: three lookups, so two cards show and the oldest folds into a chip.
    const asks = ['Hey mimir, I need a wall mount for this thermostat. Can we print it?', 'another backplate for the thermostat', 'and one more backplate for the thermostat']
    for (const [i, ask] of asks.entries()) {
      await composer.getByRole('textbox').fill(ask)
      await composer.getByRole('button', { name: 'Send' }).click()
      await page.getByTestId('mimir-choice').nth(i).getByRole('button', { name: 'Yes, that one' }).click()
      await page.getByTestId('mimir-sheet-build').click()
      await expect(page.getByTestId('mimir-transcript').locator('[data-lookup-id]')).toHaveCount(i + 1)
    }
    await expect(cards).toHaveCount(2)
    await expect(page.locator('.mimir-lookup-more')).toBeVisible()
    // the build opened the timeline for a moment; it shuts once the pointer is away
    await page.mouse.move(700, 300)
    await expect(timeline).toBeHidden({ timeout: 15_000 })
    await viewAtRest(page)
    const band = async () => (await page.locator('.mimir-lookups').boundingBox())!
    // With two cards up the part is framed above them: its center is above the band.
    const center = await page.evaluate(() => {
      type V = { x: number; y: number; z: number; set(x: number, y: number, z: number): V; applyMatrix4(m: unknown): V; project(c: unknown): V; clone(): V }
      type Mesh = { geometry: { boundingBox: { min: V; max: V } | null; computeBoundingBox(): void }; matrixWorld: unknown }
      const w = window as unknown as { __vp: { camera: { position: V }; canvas: HTMLCanvasElement; objects: Map<string, { parts: { mesh: Mesh }[] }> }; __sx: { getState(): { selection: string | null } } }
      const vp = w.__vp
      const sel = w.__sx.getState().selection
      const entry = (sel ? vp.objects.get(sel) : undefined) ?? [...vp.objects.values()].at(-1)!
      const lo = [Infinity, Infinity, Infinity]
      const hi = [-Infinity, -Infinity, -Infinity]
      for (const { mesh } of entry.parts) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
        const { min, max } = mesh.geometry.boundingBox!
        for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
          const v = vp.camera.position.clone().set(x, y, z).applyMatrix4(mesh.matrixWorld)
          ;[v.x, v.y, v.z].forEach((c, i) => ((lo[i] = Math.min(lo[i]!, c)), (hi[i] = Math.max(hi[i]!, c))))
        }
      }
      const v = vp.camera.position.clone().set((lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2).project(vp.camera)
      const r = vp.canvas.getBoundingClientRect()
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }
    })
    const b = await band()
    expect(center.y).toBeLessThan(b.y)
    // A card closing, and the folded one rising in its place, moves nothing outside the band: the caption, the
    // timeline's tab, the size pill, the chat and its edge stay put, and the other card keeps its slot.
    const outside = () => page.locator('[data-testid="mimir-caption"], [data-testid="edge-tab-bottom"], .vp .hud-bl > *, [data-testid="mimir-chat"], [data-testid="mimir-split"], [data-testid="mimir-composer"]').evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect()
      return { what: e.getAttribute('data-testid') ?? e.className, x: r.x, y: r.y, w: r.width, h: r.height }
    }))
    const moved: Moved[] = []
    const compare = (control: string, a: Awaited<ReturnType<typeof outside>>, z: Awaited<ReturnType<typeof outside>>) => {
      expect(z.length).toBe(a.length)
      z.forEach((n, i) => {
        const o = a[i]!
        const d = { dx: n.x - o.x, dy: n.y - o.y, dw: n.w - o.w, dh: n.h - o.h }
        if (Math.max(...Object.values(d).map(Math.abs)) > LIMIT) moved.push({ control, what: o.what, ...d })
      })
    }
    const kept = cards.last()
    const keptId = await kept.getAttribute('data-lookup-id')
    const keptBox = (await kept.boundingBox())!
    let before = await outside()
    // closing the left card: the folded lookup rises into its slot
    await cards.first().getByTestId('mimir-lookup-close').click()
    await expect(page.locator('.mimir-lookup-more')).toHaveCount(0)
    await expect(cards).toHaveCount(2)
    await viewAtRest(page)
    compare('close a card, the folded one rises', before, await outside())
    const still = page.locator(`[data-testid="mimir-lookup-card"][data-lookup-id="${keptId}"]`)
    const k = (await still.boundingBox())!
    if (Math.max(Math.abs(k.x - keptBox.x), Math.abs(k.y - keptBox.y)) > LIMIT) moved.push({ control: 'close a card', what: 'the other card', dx: k.x - keptBox.x, dy: k.y - keptBox.y, dw: 0, dh: 0 })
    // closing one more leaves the last where it was
    before = await outside()
    const lastBox = (await still.boundingBox())!
    await cards.first().getByTestId('mimir-lookup-close').click()
    await expect(cards).toHaveCount(1)
    await viewAtRest(page)
    compare('close a card', before, await outside())
    const l = (await still.boundingBox())!
    if (Math.max(Math.abs(l.x - lastBox.x), Math.abs(l.y - lastBox.y)) > LIMIT) moved.push({ control: 'close a card', what: 'the last card', dx: l.x - lastBox.x, dy: l.y - lastBox.y, dw: 0, dh: 0 })
    report(info, moved)
    expect(moved).toEqual([])
  })

  test('Settings, every section', async ({ page }, info) => {
    test.slow()
    await open(page, { settingsMode: 'advanced' })
    await sx(page, { settingsOpen: true })
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    const sections = dialog.locator('.settings-nav button')
    const moved: Moved[] = []
    const n = await sections.count()
    for (let i = 0; i < n; i++) {
      await sections.nth(i).click()
      await page.waitForTimeout(300)
      const name = ((await sections.nth(i).textContent()) ?? '').trim()
      moved.push(...(await probe(page, `Settings ${name}`, dialog.locator('.settings-body'))))
    }
    moved.push(...(await probe(page, 'Settings sections', dialog.locator('.settings-nav'))))
    report(info, moved)
    expect(moved).toEqual([])
  })

  test('First run, the theme and look steps', async ({ page }, info) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.debug', '1')
    })
    await page.goto('./')
    const fr = page.locator('.fr').first()
    await expect(fr).toBeVisible({ timeout: 60_000 })
    const moved: Moved[] = []
    for (const step of ['theme', 'look'] as const) {
      await sx(page, { agreementOpen: false, setup: { step } })
      await page.waitForTimeout(500)
      moved.push(...(await probe(page, `First run ${step}`, page.locator('.fr').first())))
    }
    report(info, moved)
    expect(moved).toEqual([])
  })
})

/** The boxes of what `selector` finds, in order. */
const boxesOf = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }))

/** The panes have stopped sliding and the view's width holds: two reads 100 ms apart agree, with no pane transition running. */
async function settled(page: Page): Promise<void> {
  let last = -1
  await expect
    .poll(async () => {
      const w = await page.locator('.vp').evaluate((el) => (document.getAnimations().some((a) => a.playState === 'running' && a.effect instanceof KeyframeEffect && a.effect.target instanceof Element && a.effect.target.matches('.pane, .vp')) ? -1 : Math.round(el.getBoundingClientRect().width)))
      const done = w > 0 && w === last
      last = w
      return done
    }, { intervals: [100] })
    .toBe(true)
}

/** What moved between two lists of boxes, by more than half a pixel. */
function shifts(what: string, before: { x: number; y: number; w: number; h: number }[], after: { x: number; y: number; w: number; h: number }[]): Moved[] {
  expect(after.length, what).toBe(before.length)
  const out: Moved[] = []
  after.forEach((a, i) => {
    const b = before[i]!
    const d = { dx: a.x - b.x, dy: a.y - b.y, dw: a.w - b.w, dh: a.h - b.h }
    if (Math.max(...Object.values(d).map(Math.abs)) > LIMIT) out.push({ control: what, what: `item ${i}`, ...d })
  })
  return out
}

test.describe('the view\'s panels open without moving anything', () => {
  test.skip(({ isMobile }) => isMobile, 'Desktop width: on a phone the panes are sheets and the toolbar is off')

  /** Opens with the shut right pane and the shut playback bar people get, and slices. */
  async function sliceShut(page: Page): Promise<void> {
    await page.addInitScript(() => {
      sessionStorage.setItem('sx-right-pane', 'shut')
      sessionStorage.setItem('sx-preview-drawer', 'shut')
      localStorage.setItem('slicerx.debug', '1')
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' }, printerId: 'bay-1', settingsMode: 'simple' }))
    })
    await page.goto('./')
    // The objects list is in the shut right pane: the plate is in once the store has the starter and the view is up.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sx?: { getState(): { plate: { name: string }[] } } }).__sx?.getState().plate.some((p) => p.name.includes('Layered X')) ?? false), { timeout: 120_000 }).toBe(true)
    await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
  }

  test('the toolbar grip shows on hover and no button moves', async ({ page }, info) => {
    await open(page, { settingsMode: 'simple' })
    const bar = page.locator('.plate-tools-group')
    await expect(bar).toBeVisible()
    await page.mouse.move(5, 5)
    const grip = page.getByTestId('plate-tools-grip')
    await expect.poll(() => grip.evaluate((el) => getComputedStyle(el).opacity)).toBe('0')
    const sel = '.plate-tools-group .sx-btn, .plate-tools-group .slice-look button, .plate-tools-group > *'
    const before = await boxesOf(page, sel)
    await page.locator('.plate-tools [aria-label="Undo"]').hover()
    await expect.poll(() => grip.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    const moved = shifts('toolbar on hover', before, await boxesOf(page, sel))
    report(info, moved)
    expect(moved).toEqual([])
  })

  test('opening the playback bar and the right pane moves nothing above or beside them', async ({ page }, info) => {
    test.slow()
    await sliceShut(page)
    const tab = page.getByTestId('edge-tab-right')
    await expect(tab).toHaveAttribute('aria-expanded', 'false')
    // Above the right pane: the top bar; beside it: the settings sidebar's controls.
    const beside = '.sx-appbar .sx-tab, .sx-appbar .sx-btn, aside.pane[data-side="left"] [role="radio"], aside.pane[data-side="left"] .mc-box'
    const before = await boxesOf(page, beside)
    const n = Number((await page.locator('.studio').getAttribute('data-slices')) ?? 0)
    await page.mouse.click(700, 450)
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.locator(`.studio[data-layers][data-slice="current"]:not([data-slices="${n}"])`)).toBeVisible({ timeout: 120_000 })
    await expect(tab).toHaveAttribute('aria-expanded', 'true')
    await settled(page)
    const moved = shifts('right pane opening', before, await boxesOf(page, beside))
    // Above the playback bar: the toolbar, the chips over the bar, the layer slider and the legend.
    const dock = page.getByTestId('preview-drawer')
    await expect(dock).toHaveAttribute('data-mode', 'slim')
    const above = '.plate-tools-group, .vp .hud-bl > *, .vp .lstrip, .vp .hud-top .hud-col > *'
    const top = await boxesOf(page, above)
    await dock.getByTestId('edge-tab-bottom').click()
    await expect(dock).toHaveAttribute('data-mode', 'full')
    await settled(page)
    moved.push(...shifts('playback bar opening', top, await boxesOf(page, above)))
    report(info, moved)
    expect(moved).toEqual([])
  })
})
