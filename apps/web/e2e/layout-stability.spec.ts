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
    // Text size and font weight restyle every text on screen, the pressed option with it: they are left out.
    const restyles = await control.evaluate((el) => Boolean(el.closest('[role="radiogroup"][aria-label="Text size"], [role="radiogroup"][aria-label="Font weight"]')))
    if (restyles) continue
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
