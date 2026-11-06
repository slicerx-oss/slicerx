// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Journey: Home asks about the plate before any G28. Homing Z brings the nozzle down to the plate, so the hub homes only
// a plate it knows is clear, as a print start asks. On the device page's Move tab, against a real sx-link and the
// Klipper mock: a printer the hub has never seen asks first and nothing reaches the printer until the person answers;
// the answer homes once; a finished printer is refused with bed_check and asks again. Each step reads the mock's own
// command log, not just the page. The harness, with this file's own hub on a free loopback port, is in e2e/bridge-hub.ts.
// Needs SX_LINK_BIN (a built sx-link); the tests skip without it.
import type { Locator, Page } from '@playwright/test'
import { ONBOARDING_VERSION } from '../../../../packages/app/src/first-run/onboarding.ts'
import { connectApp, ctl, hub, logOf, sawToast, toastsWith, useBridge } from '../bridge-hub'
import { expect, journey as test } from '../journey'
import { toSlice } from './lib/slice'

test.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', cadTools: true, firstRun: { completedAt: '2026-10-01T00:00:00.000Z', step: 'done', look: { id: 'slicerx' }, printerId: null, version: ONBOARDING_VERSION } } })

const ID = 'bench'
const NAME = 'Bench'

// Serial: the steps follow one plate, from never seen to answered to a finished print.
useBridge(['moonraker'], async () => {
  await hub.admin.addPrinter({ id: ID, name: NAME, plugin: 'moonraker', host: '127.0.0.1', port: hub.ports['moonraker'] ?? 0 }, { vendor: 'Voron', model: '2.4' })
})

/** G28 lines the Klipper mock has received. */
const g28s = async (): Promise<number> => (await logOf('moonraker')).filter((l) => /^gcode G28$/i.test(l.trim())).length

/** The hub's refusals of the page's home calls, by code, in the order they came. */
const refusals: string[] = []

/** The Move tab of the printer's controls dialog. */
async function moveTab(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Printers', exact: true }).first().click()
  const card = page.getByRole('article', { name: new RegExp(`^${NAME},`) })
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByTestId('printer-card-options').click()
  await page.getByRole('menuitem', { name: 'Controls and files' }).click()
  const dialog = page.getByRole('dialog', { name: `${NAME}: controls and files` })
  await expect(dialog.getByRole('button', { name: 'Home', exact: true })).toBeVisible()
  return dialog
}

const question = (dialog: Locator) => dialog.getByRole('alertdialog', { name: 'Confirm home' })

test('a printer the hub has never seen asks about the plate, and nothing homes before the answer', async ({ page }) => {
  const homes = new Set<number>()
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      const sent = String(f.payload)
      if (/"method":"home"/.test(sent)) homes.add(Number(/"id":(\d+)/.exec(sent)?.[1]))
    })
    ws.on('framereceived', (f) => {
      const got = String(f.payload)
      const id = Number(/"id":(\d+)/.exec(got)?.[1])
      const code = /"code":"([a-z_]+)"/.exec(got)?.[1]
      if (homes.has(id) && code) refusals.push(code)
    })
  })
  await toSlice(page)
  await connectApp(page)
  await expect.poll(async () => (await hub.admin.status(ID)).state, { timeout: 20_000 }).toBe('idle')
  const dialog = await moveTab(page)
  await dialog.getByRole('button', { name: 'Home', exact: true }).click()
  await expect(question(dialog)).toBeVisible()
  await expect(question(dialog)).toContainText('Is the build plate clear?')
  expect(refusals).toEqual(['bed_check'])
  expect(await g28s()).toBe(0)
  expect(await toastsWith(page, /Homing/)).toBe(0)
})

test('the answer homes once, and only then says so', async ({ page }) => {
  const dialog = page.getByRole('dialog', { name: `${NAME}: controls and files` })
  await question(dialog).getByRole('button', { name: 'Plate is clear, home' }).click()
  await expect.poll(g28s).toBe(1)
  await sawToast(page, /Homing Bench/)
  await expect(question(dialog)).toBeHidden()
  expect(await g28s()).toBe(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('a finished printer is refused with bed_check and asks again, then homes once more on the answer', async ({ page }) => {
  await ctl('/set', { mock: 'moonraker', state: 'finished' })
  try {
    await expect.poll(async () => (await hub.admin.status(ID)).state, { timeout: 20_000 }).toBe('finished')
    // The earlier step's note is gone, so a Homing note now could only be this home's.
    await page.evaluate(() => (window as unknown as { __toasts?: string[] }).__toasts?.splice(0))
    await expect(page.getByTestId('toast').filter({ hasText: 'Homing' })).toHaveCount(0, { timeout: 15_000 })
    const dialog = await moveTab(page)
    const before = refusals.length
    await dialog.getByRole('button', { name: 'Home', exact: true }).click()
    await expect(question(dialog)).toBeVisible()
    expect(refusals.slice(before)).toEqual(['bed_check'])
    expect(await g28s()).toBe(1)
    expect(await toastsWith(page, /Homing/)).toBe(0)
    await question(dialog).getByRole('button', { name: 'Plate is clear, home' }).click()
    await expect.poll(g28s).toBe(2)
    await sawToast(page, /Homing Bench/)
    await page.keyboard.press('Escape')
  } finally {
    await ctl('/set', { mock: 'moonraker', state: 'idle' })
  }
})
