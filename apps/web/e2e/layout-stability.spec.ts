// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Pressing a radio, a segmented option, a select, a checkbox, a switch, a tab or a section header never moves
// anything: the pressed control, and everything before it in its panel, stay put to half a pixel. New content opens
// below. Each screen's controls are pressed one by one and measured before and after.
import { mkdirSync, writeFileSync } from 'node:fs'
import { type Locator, type Page, type TestInfo } from '@playwright/test'
import { expect, openSheet, plateReady, test, viewportReady } from './fixtures'
import { command, facePick, freshBox, pick } from './cad-helpers'

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

/** mimir cloud against a stub on the page's own origin, answering every message with one line; returns the dock once the answer shows. */
async function mimirChat(page: Page): Promise<Locator> {
  const reply = 'A 20 mm cube is easy. I put one on the grid at the origin.'
  await page.route('**/functions/v1/mimir/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const at = path.slice(path.indexOf('/mimir') + '/mimir'.length)
    if (at === '/quota') return route.fulfill({ json: { edition: 'slicerx-web', day: '2026-10-13', install_used: 0, install_cap: 250000, ip_used: 0, ip_cap: 1000000, edition_open: true } })
    if (at !== '/v1/messages') return route.fulfill({ status: 404, json: {} })
    const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
    const body = [
      ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1 } } }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
      ev('message_stop', {}),
    ].join('')
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body })
  })
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('sx-mimir-dock', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'on', provider: 'mimir-cloud' } }))
  })
  await page.goto('./')
  await viewportReady(page)
  await page.evaluate((token) => {
    const w = window as unknown as { __sxMimirCloud(h: unknown, base: string): void; __sxBrowserMimirCloud(base: string, token: string): unknown }
    const base = `${location.origin}/functions/v1/mimir`
    w.__sxMimirCloud(w.__sxBrowserMimirCloud(base, token), base)
  }, 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJlMmUifQ.c2ln')
  await sx(page, { pilotPrompt: 'a 20 mm cube' })
  await page.getByTestId('mimir-notice-ok').click()
  const dock = page.locator('.mimir-dock')
  await expect(dock.getByText(reply)).toBeVisible({ timeout: 30_000 })
  return dock
}

/** Turns Show thinking on and off from the dock's More menu; what moved among the boxes `sel` matches. */
async function thinkingMoves(page: Page, sel: string): Promise<Moved[]> {
  const boxes = () => page.locator(sel).evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }))
  const moved: Moved[] = []
  for (const on of [true, false]) {
    const before = await boxes()
    await page.getByTestId('mimir-foot-more').click()
    const item = page.getByTestId('mimir-foot-menu').getByTestId('mimir-foot-thinking')
    await expect(item).toHaveAttribute('aria-checked', String(!on))
    await item.click()
    await expect(page.getByTestId('mimir-foot-menu')).toHaveCount(0)
    await page.waitForTimeout(350)
    const after = await boxes()
    expect(after.length).toBe(before.length)
    after.forEach((n, i) => {
      const o = before[i]!
      const d = { dx: n.x - o.x, dy: n.y - o.y, dw: n.w - o.w, dh: n.h - o.h }
      if (Math.max(...Object.values(d).map(Math.abs)) > LIMIT) moved.push({ control: `Show thinking ${on ? 'on' : 'off'}`, what: `item ${i}`, ...d })
    })
    await page.getByTestId('mimir-foot-more').click()
    await expect(page.getByTestId('mimir-foot-thinking')).toHaveAttribute('aria-checked', String(on))
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('mimir-foot-menu')).toHaveCount(0)
  }
  return moved
}

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

  test('Model on a phone: the bar, the handles and the sketch tools', async ({ page, isMobile }, info) => {
    test.skip(!isMobile, 'Phone only; the desktop shelf is covered by Model panels')
    // the browser build that models only, where a phone gets Model
    await page.addInitScript(() => {
      localStorage.setItem('slicerx.debug', '1')
      localStorage.setItem('slicerx.e2e.cadOnly', '1')
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
    })
    await page.goto('./')
    await page.locator('html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: 120_000 })
    const slots = () => page.locator('.pbar-slot').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))
    const moved: Moved[] = []
    // Edit and Tree open their sheets: no slot of the bar moves or changes size
    for (const id of ['phone-edit', 'phone-tree']) {
      const before = await slots()
      await page.getByTestId(id).click()
      await page.waitForTimeout(350)
      const after = await slots()
      before.forEach((b, i) => {
        const a = after[i]!
        const d = { dx: a.x - b.x, dy: a.y - b.y, dw: a.width - b.width, dh: a.height - b.height }
        if (Math.max(...Object.values(d).map(Math.abs)) > LIMIT) moved.push({ control: `Model bar: ${id}`, what: `slot ${i}`, ...d })
      })
      // shut it again: the tree's scrim, or Edit's own slot
      if (await page.locator('.sheet-scrim').count()) await page.locator('.sheet-scrim').click({ position: { x: 20, y: 20 } })
      else await page.getByTestId(id).click()
      await page.waitForTimeout(350)
    }
    // the handles, with a box picked
    await sx(page, { plate: [], selection: null, selectedIds: [] })
    await page.getByTestId('phone-add').click()
    await page.getByRole('menu', { name: 'Add' }).getByRole('menuitem', { name: 'Box' }).first().click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate.length)).toBe(1)
    await page.evaluate(() => {
      const s = (window as unknown as { __sx: { getState(): { plate: { id: string }[] }; setState(p: unknown): void } }).__sx
      const id = s.getState().plate[0]!.id
      s.setState({ selection: id, selectedIds: [id] })
    })
    moved.push(...(await probe(page, 'Model handles', page.getByTestId('phone-handles'))))
    // the sketch's two rows in the bar
    await page.getByTestId('phone-sketch').click()
    await expect(page.getByRole('complementary', { name: 'Tool and transform' })).toContainText('Tap an origin plane')
    await page.evaluate(() => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('pick', { objectId: null, partIndex: null, triangle: null, point: null, bed: null, originPlane: 'xy' }))
    await expect(page.getByTestId('phone-sketch-bar').getByRole('radiogroup', { name: 'Drawing tool' })).toBeVisible()
    moved.push(...(await probe(page, 'Sketch tools', page.getByTestId('phone-sketch-bar'))))
    report(info, moved)
    expect(moved).toEqual([])
  })

  test('every tool panel in Model, with nothing past its edge', async ({ page, isMobile }, info) => {
    test.skip(isMobile, 'The tool panels are sheets on a phone; covered at desktop width')
    test.slow()
    await open(page, { settingsMode: 'advanced' })
    await page.locator('.sx-tab[data-mode="design"]').click()
    await expect(page.getByTestId('model-tree')).toBeVisible()
    // each tool with what it needs picked first, so its fields and choices are on screen
    const tools: { title: string; top?: boolean }[] = [
      { title: 'Fit a hole for a screw or insert', top: true },
      { title: 'Push or pull a face', top: true },
      { title: 'Fillet or chamfer edges' },
      { title: 'Shell: hollow with faces left open', top: true },
      { title: 'Cut a thread in a hole or on a rod' },
      { title: 'Cut the selected object with a plane' },
      { title: 'Array: linear, grid or circular copies' },
      { title: 'Measure distance, angle and radius' },
      { title: 'Shape on a face: rectangle, circle, slot or polygon', top: true },
      { title: 'Sketch on the bed or a face, then extrude or revolve', top: true },
    ]
    const moved: Moved[] = []
    const past: string[] = []
    for (const t of tools) {
      const id = await freshBox(page)
      await sx(page, { selection: id, selectedIds: [id] })
      await command(page, t.title)
      const panel = page.locator('[data-section="cad-tool"], [data-section="cut-tool"]').first()
      await expect(panel).toBeVisible()
      if (t.top) await pick(page, await facePick(page, id, [0, 0, 1]))
      await page.waitForTimeout(400)
      // nothing in the panel runs past its content box: no segment, select or button cut at the right or the left
      past.push(
        ...(await panel.evaluate((el) => {
          const cs = getComputedStyle(el)
          const r = el.getBoundingClientRect()
          const left = r.left + parseFloat(cs.paddingLeft) - 1
          const right = r.right - parseFloat(cs.paddingRight) + 1
          const name = el.querySelector('h3')?.textContent ?? ''
          return [...el.querySelectorAll('button, select, input:not([type="file"]), .tp-label')]
            .filter((c) => {
              const b = c.getBoundingClientRect()
              return b.width > 0 && (b.left < left || b.right > right)
            })
            .map((c) => `${name}: ${c.tagName.toLowerCase()} "${(c.textContent || c.getAttribute('aria-label') || '').trim().slice(0, 30)}"`)
        })),
      )
      moved.push(...(await probe(page, `${t.title.split(':')[0]} panel`, panel)))
      await sx(page, { objectTool: null })
      await expect(panel).toHaveCount(0)
    }
    report(info, moved)
    expect(past).toEqual([])
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
      // the sheet waits on its record in the chat: pressing Confirm sizes and build moves nothing on the record
      const rec = page.locator('[data-testid="mimir-sheet-record"]').nth(i)
      const confirm = rec.getByTestId('mimir-sheet-confirm')
      await expect(confirm).toHaveText('Confirm sizes and build')
      const parts = [confirm, rec.getByTestId('mimir-sheet-cancel'), rec.getByTestId('mimir-sheet-status'), rec.locator('.sheet-rec-rows')]
      const at = () => Promise.all(parts.map(async (l) => (await l.boundingBox())!))
      const was = await at()
      await confirm.hover()
      await page.mouse.down()
      await page.waitForTimeout(150)
      const held = await at()
      held.forEach((n, k) => {
        const o = was[k]!
        expect(Math.max(Math.abs(n.x - o.x), Math.abs(n.y - o.y), Math.abs(n.width - o.width), Math.abs(n.height - o.height)), `record part ${k} while Confirm is held`).toBeLessThanOrEqual(LIMIT)
      })
      await page.mouse.up()
      await expect(page.getByTestId('mimir-transcript').locator('[data-lookup-id]')).toHaveCount(i + 1)
    }
    await expect(cards).toHaveCount(2)
    await expect(page.locator('.mimir-lookup-more')).toBeVisible()
    // the timeline stays shut once the pointer is away from the view's bottom band
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
    const moved: Moved[] = []
    // A phone lists the sections and opens each on its own page, with Back to the list.
    const listed = (await dialog.locator('.settings-list').count()) > 0
    const sections = dialog.locator(listed ? '.settings-list button[data-testid^="settings-nav-"]' : '.settings-nav button')
    const n = await sections.count()
    expect(n).toBeGreaterThan(1)
    for (let i = 0; i < n; i++) {
      const name = ((await sections.nth(i).textContent()) ?? '').trim()
      await sections.nth(i).click()
      await page.waitForTimeout(300)
      moved.push(...(await probe(page, `Settings ${name}`, dialog.locator('.settings-body'))))
      if (listed) {
        await dialog.getByTestId('settings-back').click()
        await expect(dialog.locator('.settings-list')).toBeVisible()
      }
    }
    if (!listed) moved.push(...(await probe(page, 'Settings sections', dialog.locator('.settings-nav'))))
    report(info, moved)
    expect(moved).toEqual([])
  })

  test('the phone tab bar and the mimir page', async ({ page, isMobile }, info) => {
    test.skip(!isMobile, 'The tab bar is the phone layout; desktop keeps its tabs in the top bar')
    await open(page, { pilot: { mode: 'unset' } })
    const tabs = page.getByTestId('phone-tabs')
    await expect(tabs).toBeVisible()
    // Nothing in either bar moves or resizes as the tabs are pressed: the top bar's name and buttons, and every tab.
    const boxes = () => page.locator('.sx-appbar .sx-projname, .sx-appbar .sx-btn, .phone-tab').evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }))
    const moved: Moved[] = []
    const compare = (control: string, a: Awaited<ReturnType<typeof boxes>>, z: Awaited<ReturnType<typeof boxes>>) => {
      expect(z.length).toBe(a.length)
      z.forEach((n, i) => {
        const o = a[i]!
        const d = { dx: n.x - o.x, dy: n.y - o.y, dw: n.w - o.w, dh: n.h - o.h }
        if (Math.max(...Object.values(d).map(Math.abs)) > LIMIT) moved.push({ control, what: `bar item ${i}`, ...d })
      })
    }
    // every tab is a full touch target
    for (const b of await page.locator('.phone-tab').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(b).toBeGreaterThanOrEqual(44)
    let before = await boxes()
    await page.getByTestId('tab-mimir').click()
    await expect(page.locator('.mimir-dock')).toBeVisible()
    await expect(page.getByTestId('tab-mimir')).toHaveAttribute('aria-current', 'page')
    await page.waitForTimeout(350)
    compare('phone-tab-mimir', before, await boxes())
    // the page sits between the bars and covers the screen's width
    const dock = (await page.locator('.mimir-dock').boundingBox())!
    const bar = (await tabs.boundingBox())!
    expect(dock.x).toBe(0)
    expect(dock.width).toBe(page.viewportSize()!.width)
    expect(dock.y + dock.height).toBeLessThanOrEqual(bar.y + 0.5)
    moved.push(...(await probe(page, 'phone mimir', page.locator('.mimir-dock'))))
    before = await boxes()
    await page.locator('.phone-tab').first().click()
    await expect(page.locator('.mimir-dock')).toHaveCount(0)
    await page.waitForTimeout(350)
    compare('first phone tab', before, await boxes())
    report(info, moved)
    expect(moved).toEqual([])
  })

  test('mimir on a phone: the slow-graphics notice keeps off the chat, and Show thinking moves nothing', async ({ page, isMobile }, info) => {
    test.skip(!isMobile, 'Phone only: a desktop keeps the toast beside the dock (covered below)')
    const dock = await mimirChat(page)

    // The viewport's own slow-graphics event: a phone shows a warning icon in the top bar, never a toast.
    const text = 'Hardware acceleration looks off in this browser, so the 3D view will be slow. Turn it on in the browser settings and reload.'
    await page.evaluate((m) => (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp.emit('degrade', { message: m }), text)
    const icon = page.locator('.sx-appbar').getByTestId('phone-view-notice')
    await expect(icon).toBeVisible()
    const ib = (await icon.boundingBox())!
    expect(Math.min(ib.width, ib.height)).toBeGreaterThanOrEqual(44)
    await page.waitForTimeout(400)
    await expect(page.getByTestId('toast').filter({ hasText: 'Hardware acceleration' })).toHaveCount(0)
    // nothing floats over the conversation or the composer
    const chat = (await dock.locator('.term-body').boundingBox())!
    const composer = (await dock.locator('.term-in').boundingBox())!
    for (const t of await page.locator('.sx-toast').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0).map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })))) {
      for (const a of [chat, composer]) expect(t.x < a.x + a.width && a.x < t.x + t.width && t.y < a.y + a.height && a.y < t.y + t.height).toBe(false)
    }
    // a tap opens the whole notice, inside the screen, and a tap elsewhere shuts it
    await icon.click()
    const note = page.getByTestId('phone-view-notice-text')
    await expect(note).toHaveText(text)
    const nb = (await note.boundingBox())!
    expect(nb.x).toBeGreaterThanOrEqual(0)
    expect(nb.x + nb.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.mouse.click(20, chat.y + chat.height / 2)
    await expect(note).toHaveCount(0)

    // One header row above the chat: the terminal's bar is gone, Pause sits beside More, Show thinking is in More.
    await expect(dock.locator('.term-bar')).toBeHidden()
    const pause = page.getByTestId('mimir-foot-pause')
    await expect(pause).toBeVisible()
    expect(Math.min(...Object.values((await pause.boundingBox())!).slice(2))).toBeGreaterThanOrEqual(44)
    const moved = await thinkingMoves(page, '.sx-appbar .sx-btn, .sx-appbar .sx-projname, .mimir-dock > .mimir-foot > *, .mimir-dock .term-body, .mimir-dock .term-in, .phone-tab')
    await page.screenshot({ path: info.outputPath('phone-mimir-header.png') })
    report(info, moved)
    expect(moved).toEqual([])
  })

  test('the mimir dock on a desktop: two header rows, and Show thinking moves nothing', async ({ page, isMobile }, info) => {
    test.skip(isMobile, 'Desktop only: a phone has its own header row (covered above)')
    const dock = await mimirChat(page)
    // The panel header, then one row of conversation controls: no terminal bar, no links under the composer.
    await expect(dock.locator('.term-bar')).toHaveCount(0)
    await expect(dock.getByRole('button', { name: 'Replay this run' })).toHaveCount(0)
    const head = (await dock.locator('> .mimir-head').boundingBox())!
    const row = (await dock.locator('> .mimir-foot').boundingBox())!
    const chat = (await dock.locator('.term-body').boundingBox())!
    expect(Math.abs(row.y - (head.y + head.height))).toBeLessThanOrEqual(1)
    expect(chat.y).toBeGreaterThanOrEqual(row.y + row.height - 1)
    // Pause sits beside New conversation, More at the row's right end
    const fresh = (await dock.getByRole('button', { name: 'New conversation' }).boundingBox())!
    const pause = (await page.getByTestId('mimir-foot-pause').boundingBox())!
    const more = (await page.getByTestId('mimir-foot-more').boundingBox())!
    expect(pause.x).toBeGreaterThan(fresh.x + fresh.width)
    expect(pause.x - (fresh.x + fresh.width)).toBeLessThanOrEqual(16)
    expect(more.x).toBeGreaterThan(pause.x + pause.width)
    expect(row.x + row.width - (more.x + more.width)).toBeLessThanOrEqual(16)
    for (const b of [fresh, pause, more]) expect(b.y + b.height).toBeLessThanOrEqual(row.y + row.height + 0.5)
    // Skills and permissions and Connect an AI agent are in More with Show thinking
    await page.getByTestId('mimir-foot-more').click()
    const menu = page.getByTestId('mimir-foot-menu')
    await expect(menu.getByRole('menuitem', { name: 'Skills and permissions' })).toBeVisible()
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Show thinking' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Connect an AI agent' })).toBeVisible()
    await page.screenshot({ path: info.outputPath('desktop-mimir-more.png') })
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    const moved = await thinkingMoves(page, '.sx-appbar .sx-btn, .mimir-dock > .mimir-head > *, .mimir-dock > .mimir-foot > *, .mimir-dock .term-body, .mimir-dock .term-in')
    report(info, moved)
    expect(moved).toEqual([])
  })

  test('a toast never lands on the mimir dock, beside the view or over it', async ({ page, isMobile }, info) => {
    test.skip(isMobile, 'Desktop widths; a phone keeps the slow-graphics notice in its top bar (covered above)')
    const text = 'Hardware acceleration looks off in this browser, so the 3D view will be slow. Turn it on in the browser settings and reload.'
    await page.addInitScript(() => localStorage.setItem('sx-mimir-dock', '1'))
    for (const width of [1440, 1100, 1000]) {
      await page.setViewportSize({ width, height: 900 })
      await open(page, { pilot: { mode: 'unset' } })
      const dock = page.locator('.mimir-dock')
      await expect(dock).toBeVisible()
      await page.evaluate((t) => (window as unknown as { __sx: Sx }).__sx.setState({ toast: { id: Date.now(), text: t, tone: 'info' } }), text)
      const toast = page.getByTestId('toast').filter({ hasText: 'Turn it on in the browser settings' }).last()
      await expect(toast).toBeVisible()
      const t = await toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }))
      const d = (await dock.boundingBox())!
      const overlaps = t.x < d.x + d.width && d.x < t.x + t.width && t.y < d.y + d.height && d.y < t.y + t.height
      if (overlaps) await page.screenshot({ path: info.outputPath(`toast-over-dock-${width}.png`) })
      expect(overlaps, `toast ${JSON.stringify(t)} over the dock ${JSON.stringify(d)} at ${width} px`).toBe(false)
    }
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
    // Clearing the selection offers the filaments to move; measure that state before opening the pane.
    await page.mouse.click(700, 450)
    const before = await boxesOf(page, beside)
    const n = Number((await page.locator('.studio').getAttribute('data-slices')) ?? 0)
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.locator(`.studio[data-layers][data-slice="current"]:not([data-slices="${n}"])`)).toBeVisible({ timeout: 120_000 })
    await expect(tab).toHaveAttribute('aria-expanded', 'true')
    await settled(page)
    const moved = shifts('right pane opening', before, await boxesOf(page, beside))
    // Above the playback bar: the toolbar, the chips over the bar, the layer slider and the legend.
    const dock = page.getByTestId('preview-drawer')
    await expect(dock).toHaveAttribute('data-mode', 'slim')
    const above = '.plate-tools-group, .vp .hud-bl > *, .vp .hud-top .hud-col > *'
    const top = await boxesOf(page, above)
    await dock.getByTestId('edge-tab-bottom').click()
    await expect(dock).toHaveAttribute('data-mode', 'full')
    await settled(page)
    moved.push(...shifts('playback bar opening', top, await boxesOf(page, above)))
    report(info, moved)
    expect(moved).toEqual([])
  })
})
