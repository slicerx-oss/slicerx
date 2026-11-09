// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plan approved in the mimir tab outlives the session. The scripted mounting plate is built as far as its plate (the
// reply ends on a question the plan does not settle, so mimir stops there), the project is saved, and the page is
// loaded again, which forgets every chat and plan the tab held, as quitting the app does. The saved project is opened,
// and "keep going" in a new chat builds the screw holes the plan still needs and checks the part against it, with the
// one line that says mimir went on. Before the project kept its plans, that message got the scripted line alone. The
// same flow runs on the engine in packages/app/test/mimir-plan-restored.test.ts.
import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import type { Page } from '@playwright/test'
import { addMenu, appReady, goTab } from '../fixtures'
import { journey, expect } from '../journey'
import { openModel, useFileDialogs } from './lib/model'
import { askTab, debugOn, emptyMimirTab, setPilot } from './lib/session'

journey.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', cadTools: true, pilot: { mode: 'on', provider: 'anthropic' } } })
useFileDialogs()

/** The objects on the plate with the plan feature of each of their steps. */
const plate = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __sx: { getState(): { plate: { name: string; history?: { steps: { feature?: string }[] } }[] } } }).__sx
      .getState()
      .plate.map((e) => ({ name: e.name, steps: (e.history?.steps ?? []).map((s) => s.feature ?? null) })),
  )

/** The entries of a saved project, read through their local headers (a save deflates them). */
function entries(bytes: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50; ) {
    const method = bytes.readUInt16LE(at + 8)
    const size = bytes.readUInt32LE(at + 18)
    const nameLen = bytes.readUInt16LE(at + 26)
    const start = at + 30 + nameLen + bytes.readUInt16LE(at + 28)
    const raw = bytes.subarray(start, start + size)
    out.set(bytes.subarray(at + 30, at + 30 + nameLen).toString(), (method === 8 ? inflateRawSync(raw) : raw).toString())
    at = start + size
  }
  return out
}

/** Save project from the Export menu; headless Chromium has no save picker, so the save comes down as a download. */
async function saveProject(page: Page): Promise<Buffer> {
  await goTab(page, 'prepare')
  await page.evaluate(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
  await addMenu(page, 'Export')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Save project/ }).click()])
  return readFileSync(await download.path())
}

journey.describe('mimir finishes a plan from a project opened again', () => {
  journey('a half built mounting plate, saved and opened after a reload: keep going builds the screw holes and checks it', async ({ page }) => {
    await debugOn(page)
    await setPilot(page, 'scripted')
    await emptyMimirTab(page)
    await askTab(page, 'Make a mounting plate, just the plate for now')
    const confirm = page.getByTestId('mimir-sheet-confirm')
    await expect(confirm).toBeEnabled({ timeout: 30_000 })
    await confirm.click()
    const go = page.getByTestId('mimir-plan-go')
    await expect(go).toBeEnabled({ timeout: 30_000 })
    await go.click()
    const transcript = page.getByTestId('mimir-transcript')
    await expect(transcript).toContainText('The plate is built. Which screws will hold it, M4 or M3?', { timeout: 30_000 })
    // the question is the person's to answer: mimir stopped with the plan half built
    await expect(page.getByTestId('mimir-plan-left')).toHaveCount(0)
    await expect.poll(() => plate(page)).toEqual([{ name: 'Mounting plate', steps: ['Plate'] }])

    const saved = await saveProject(page)
    const plans = JSON.parse(entries(saved).get('Metadata/slicerx_plans.json') ?? 'null') as { version: number; plans: { plan: { part: string }; steps: string[] }[] } | null
    expect(plans?.version).toBe(1)
    expect(plans?.plans.map((p) => p.plan.part)).toEqual(['Mounting plate'])

    // a reload forgets every chat and plan the tab held, as quitting the app does
    await page.reload()
    await appReady(page)
    const discard = page.getByTestId('danger-recover-discard')
    if (await discard.isVisible().catch(() => false)) await discard.click()
    await debugOn(page)
    await setPilot(page, 'scripted')
    await goTab(page, 'prepare')
    await openModel(page, { name: 'Mounting plate.sx3mf', mimeType: 'application/octet-stream', buffer: saved })
    await expect.poll(() => plate(page)).toEqual([{ name: 'Mounting plate', steps: ['Plate'] }])

    await page.getByTestId('tab-mimir').click()
    const chat = page.getByTestId('mimir-chat')
    await expect(chat).toBeVisible()
    const again = chat.getByRole('button', { name: 'New conversation' })
    if (await again.isVisible()) await again.click()
    await askTab(page, 'keep going')
    await expect(transcript).toContainText('Picking up where the project left off.', { timeout: 30_000 })
    await expect(transcript).toContainText('Done: the mounting plate, 80 x 50 x 4 mm with four 4.5 mm screw holes. It matches the plan.', { timeout: 30_000 })
    const line = page.getByTestId('mimir-plan-left')
    await expect(line).toHaveCount(1)
    await expect(line).toHaveText('mimir went on to the parts the plan still needs: Screw holes.')
    await expect.poll(() => plate(page)).toEqual([{ name: 'Mounting plate', steps: ['Plate', 'Screw holes'] }])
  })
})
