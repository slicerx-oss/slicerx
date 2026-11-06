// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings rows on a phone (the kit's SettingRow) are laid out by group, the rows that share a list. A group stays
// inline, label and control on one line, unless one of its labels would need more than two lines beside its control;
// then the whole group stacks: each label on its own line and the value under it, a number or a select at its own
// width against the right edge, a segmented choice from the label's x to that edge, a switch still beside its label.
// Every control is a 44 px tap either way, and a reset showing on a changed row moves nothing. Settings > Controls
// stays inline at 390; the Printer settings dialog's Basic information stacks.
import type { Locator, Page } from '@playwright/test'
import { closeSheet } from '../fixtures'
import { expect, sidebarAs, sidebarDone, test } from './lib/shell'

test.skip(({ isMobile }) => !isMobile, 'Phone window; desktop rows keep the label and the control on one line')

type Row = { label: DOMRect; ctl: DOMRect; edge: number; kind: 'switch' | 'seg' | 'other'; name: string; tap: boolean }

/** Each row's label and control boxes, the right edge its controls end at, and whether the control takes a tap 21 px above and below its middle. */
async function rows(group: Locator): Promise<Row[]> {
  return group.evaluate((root) =>
    [...root.children]
      .filter((r) => r.classList.contains('sx-setrow'))
      .map((r) => {
        const kids = [...r.children] as HTMLElement[]
        const bare = r.hasAttribute('data-bare')
        const label = kids[bare ? 0 : 1]!
        const ctl = kids[bare ? 1 : 2]!
        // measured in view, where a tap can reach it
        ctl.scrollIntoView({ block: 'center' })
        const row = r.getBoundingClientRect()
        const reset = bare ? null : kids[3]!.getBoundingClientRect()
        const c = ctl.getBoundingClientRect()
        const at = (y: number) => {
          const hit = document.elementFromPoint(c.left + c.width / 2, y)
          return hit !== null && (hit === ctl || ctl.contains(hit))
        }
        const mid = c.top + c.height / 2
        return {
          label: label.getBoundingClientRect().toJSON(),
          ctl: c.toJSON(),
          // a marked row's controls end where the reset rail starts
          edge: reset ? reset.left - parseFloat(getComputedStyle(r).columnGap) : row.right,
          kind: ctl.classList.contains('sx-switch') ? 'switch' : ctl.classList.contains('sx-seg') ? 'seg' : 'other',
          name: (label.textContent ?? '').trim(),
          tap: at(mid - 21) && at(mid + 21),
        }
      }),
  )
}

const besideLabel = (r: Row) => r.ctl.top < r.label.bottom && r.ctl.bottom > r.label.top

/** One label x, one right edge, a 44 px tap on every control, and each control beside or under its label as the group says. */
async function group(scope: Locator, where: string, layout: 'inline' | 'stack'): Promise<Row[]> {
  await expect(scope, where).toHaveAttribute('data-setrows', layout)
  const list = await rows(scope)
  expect(list.length, where).toBeGreaterThan(0)
  const x = list[0]!.label.left
  for (const r of list) {
    const what = `${where}: ${r.name}`
    expect(Math.abs(r.label.left - x), what).toBeLessThanOrEqual(0.5)
    expect(Math.abs(r.ctl.right - r.edge), what).toBeLessThanOrEqual(0.5)
    expect(r.tap, `${what}: a 44 px tap`).toBe(true)
    if (layout === 'inline' || r.kind === 'switch') {
      expect(besideLabel(r), `${what}: beside its label`).toBe(true)
      // a segmented choice keeps its own width in an inline group
      if (r.kind === 'seg') expect(r.ctl.left - r.label.right, what).toBeGreaterThanOrEqual(0)
    } else {
      // under the label, 4 to 12 px below it, and the label has the line to itself
      expect(r.ctl.top - r.label.bottom, what).toBeGreaterThanOrEqual(3.5)
      expect(r.ctl.top - r.label.bottom, what).toBeLessThanOrEqual(12)
      expect(r.label.right, what).toBeGreaterThan(r.ctl.left)
      if (r.kind === 'seg') expect(Math.abs(r.ctl.left - x), what).toBeLessThanOrEqual(0.5)
      else expect(r.ctl.width, what).toBeLessThan(r.edge - x)
    }
  }
  return list
}

async function printerSettings(page: Page): Promise<Locator> {
  await page.getByTestId('phone-search').click()
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible()
  await page.keyboard.type('Printer settings')
  await page.locator('.sx-palette-item', { hasText: /^Printer settings/ }).first().click()
  const dialog = page.getByRole('dialog', { name: /Printer settings/ })
  await expect(dialog).toBeVisible()
  return dialog
}

test('Settings > Controls: the mouse and key groups fit, so each row stays on one line', async ({ page }) => {
  await sidebarAs(page, { mode: 'simple' })
  await closeSheet(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByTestId('settings-nav-controls').click()
  await expect(dialog.locator('#ctl-mouse')).toBeVisible()
  const mouse = await group(dialog.locator('.set-rows').first(), 'Mouse', 'inline')
  expect(mouse.map((r) => r.kind)).toEqual(['seg', 'seg', 'seg', 'switch', 'switch', 'switch'])
  await group(dialog.locator('.set-rows').nth(1), 'Move, rotate, scale and paint keys', 'inline')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await sidebarDone(page)
})

test('Printer settings: Basic information has labels too long to sit beside their values, so the group stacks, and a reset moves nothing', async ({ page }) => {
  await sidebarAs(page, { mode: 'simple' })
  await closeSheet(page)
  const dialog = await printerSettings(page)
  try {
    await dialog.getByRole('radiogroup', { name: 'Printer settings tab' }).getByRole('radio', { name: 'Basic information' }).click()
    const list = dialog.locator('ul.expert')
    const before = await group(list, 'Basic information', 'stack')
    // Change the first number: the dot and the reset show in their rails and nothing moves.
    const field = list.locator('li.sx-setrow > input.num').first()
    const i = await field.evaluate((el) => [...el.parentElement!.parentElement!.children].indexOf(el.parentElement!))
    await field.scrollIntoViewIfNeeded()
    await field.fill('7')
    await field.press('Enter')
    const reset = list.locator('li.sx-setrow').nth(i).getByTestId('slice-setting-reset')
    await expect(reset).toHaveCount(1)
    await expect(list).toHaveAttribute('data-setrows', 'stack')
    const after = await rows(list)
    for (const k of ['label', 'ctl'] as const) {
      // each row is measured scrolled to the middle, so its own boxes compare, not its place in the list
      expect(Math.abs(after[i]![k].left - before[i]![k].left), `${after[i]!.name} ${k}`).toBeLessThanOrEqual(0.5)
      expect(Math.abs(after[i]![k].height - before[i]![k].height), `${after[i]!.name} ${k}`).toBeLessThanOrEqual(0.5)
    }
    expect(Math.abs(after[i]!.ctl.top - after[i]!.label.top - (before[i]!.ctl.top - before[i]!.label.top))).toBeLessThanOrEqual(0.5)
    // the reset sits on its label's line
    const line = await reset.evaluate((el) => {
      const label = el.closest('.sx-setrow')!.querySelector('label')!.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      return { top: r.top - label.bottom, bottom: r.bottom - label.top }
    })
    expect(line.top).toBeLessThan(0)
    expect(line.bottom).toBeGreaterThan(0)
    await reset.click()
    await expect(reset).toHaveCount(0)
  } finally {
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  }
  await sidebarDone(page)
})

type Snap = { layout: string | null; rows: { name: string; label: number[]; ctl: number[] }[] }

/**
 * Arms a recorder for the next change of the Printer settings list: once the first frame that shows the list has
 * painted, after the fonts are ready and after a short settle, the list's layout and each row's label and
 * control box, measured from the list's own corner so a sideways scroll of the dialog does not count.
 */
async function arm(page: Page): Promise<void> {
  await page.evaluate(() => {
    const SEL = '.printer-settings ul.expert'
    const snap = (): Snap | null => {
      const g = document.querySelector(SEL)
      if (!g) return null
      const o = g.getBoundingClientRect()
      const box = (e: Element) => {
        const r = e.getBoundingClientRect()
        return [r.left - o.left, r.top - o.top, r.width, r.height]
      }
      const rows = [...g.children]
        .filter((r) => r.classList.contains('sx-setrow'))
        .map((r) => {
          const kids = [...r.children]
          return { name: (kids[1]?.textContent ?? '').trim(), label: box(kids[1]!), ctl: box(kids[2]!) }
        })
      return { layout: g.getAttribute('data-setrows'), rows }
    }
    // a task posted from a frame runs once that frame is painted, after its resize observers
    const painted = () => new Promise<void>((done) => requestAnimationFrame(() => setTimeout(done, 0)))
    const shown = () => (document.querySelector(SEL)?.getBoundingClientRect().width ?? 0) > 0
    ;(window as unknown as { rowSnaps?: Promise<(Snap | null)[]> }).rowSnaps = new Promise((done) => {
      const mo = new MutationObserver((records) => {
        const list = document.querySelector(SEL)
        if (!list || !list.querySelector(':scope > .sx-setrow')) return
        if (!records.some((m) => m.target === list || [...m.addedNodes].some((n) => n === list || (n instanceof Element && n.contains(list))))) return
        mo.disconnect()
        void (async () => {
          // the first frame that shows the list
          await painted()
          for (let i = 0; i < 60 && !shown(); i++) await painted()
          const first = snap()
          await document.fonts.ready
          await painted()
          const fonts = snap()
          await new Promise((r) => setTimeout(r, 600))
          await painted()
          done([first, fonts, snap()])
        })()
      })
      mo.observe(document.body, { childList: true, subtree: true })
    })
  })
}

/** The recorded snapshots agree: the layout is set at the first paint and nothing moves after it. */
async function steady(page: Page, where: string): Promise<string> {
  const [first, fonts, settled] = await page.evaluate(() => (window as unknown as { rowSnaps: Promise<(Snap | null)[]> }).rowSnaps)
  expect(first, `${where}: the list at the first paint`).not.toBeNull()
  expect(first!.layout, `${where}: laid out at the first paint`).toMatch(/^(stack|inline)$/)
  expect(first!.rows.length, where).toBeGreaterThan(0)
  for (const [when, s] of [['after the fonts', fonts], ['after a settle', settled]] as const) {
    expect(s!.layout, `${where}, ${when}: the group's layout`).toBe(first!.layout)
    expect(s!.rows.length, `${where}, ${when}: rows`).toBe(first!.rows.length)
    s!.rows.forEach((r, i) => {
      const a = first!.rows[i]!
      for (const k of ['label', 'ctl'] as const) {
        const d = Math.max(...r[k].map((v, j) => Math.abs(v - a[k][j]!)))
        expect(d, `${where}, ${when}: ${r.name} ${k} moved`).toBeLessThanOrEqual(0.5)
      }
    })
  }
  return first!.layout!
}

test('Printer settings: each tab\'s group is laid out at its first paint and nothing moves after it', async ({ page }) => {
  await sidebarAs(page, { mode: 'simple' })
  await closeSheet(page)
  await page.getByTestId('phone-search').click()
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible()
  await page.keyboard.type('Printer settings')
  await arm(page)
  await page.locator('.sx-palette-item', { hasText: /^Printer settings/ }).first().click()
  const dialog = page.getByRole('dialog', { name: /Printer settings/ })
  await expect(dialog).toBeVisible()
  try {
    const seen = [`Basic information ${await steady(page, 'Basic information, on open')}`]
    const tabs = dialog.getByRole('radiogroup', { name: 'Printer settings tab' }).getByRole('radio')
    const names = await tabs.allTextContents()
    expect(names.length).toBeGreaterThan(1)
    // every other tab, then back to the first
    for (const name of [...names.slice(1), names[0]!]) {
      await arm(page)
      await tabs.filter({ hasText: name }).first().click()
      seen.push(`${name} ${await steady(page, name)}`)
    }
    test.info().annotations.push({ type: 'groups', description: seen.join('; ') })
  } finally {
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  }
  await sidebarDone(page)
})
