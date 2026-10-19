// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What mimir remembers, on a phone: the Remember chip in the chat (Remember saves the note, Not now keeps nothing) and
// Settings, Memory at phone width (the notes listed, one deleted, the sync switch, and everything inside the screen).
// The desktop legs are in mimir.spec.ts. The chat is the docked one on a phone as well; the selectors that belong to the
// dock are all in openChat, askToRemember and openMemory, so a different home for the chat changes those helpers only.
import type { Locator, Page } from '@playwright/test'
import { journey, expect } from '../journey'
import { goTab, viewportReady } from '../fixtures'
import { answer, askDock, closeDialogs, debugOn, lastUserText, noHorizontalScroll, setPilot, signIn, stubProxy } from './lib/session'

journey.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', cadTools: true } })

const KEPT = 'Prints PETG on a textured plate'
const SKIPPED = 'Prefers a 0.6 mm nozzle for big parts'
const DELETED = 'Has a Bambu Lab A1 on the desk'

/** The note each request names, as mimir offers it. */
const NOTES: Record<string, { kind: string; text: string }> = {
  petg: { kind: 'filament', text: KEPT },
  nozzle: { kind: 'preference', text: SKIPPED },
  a1: { kind: 'printer', text: DELETED },
}

/** The chat on a phone, open and empty, signed in to a stubbed mimir that offers the note a request names. */
async function openChat(page: Page, opts: { account?: boolean } = {}): Promise<Locator> {
  await debugOn(page)
  await goTab(page, 'prepare')
  // the docked chat is a view choice the browser remembers, read as the page loads; the build's stand-in account makes Sync show
  await page.evaluate((account) => {
    localStorage.setItem('sx-mimir-dock', '1')
    if (account) sessionStorage.setItem('sx-e2e-memory-sync', 'stand-in-session')
  }, opts.account ?? false)
  await page.reload()
  await viewportReady(page)
  await setPilot(page, 'cloud')
  await stubProxy(page, (body) => {
    const text = lastUserText(body)
    if (text.includes('tool_result')) return answer('Noted.')
    const key = Object.keys(NOTES).find((k) => text.includes(`Remember ${k}:`))
    return key ? [{ type: 'tool_use', id: `tu_${key}`, name: 'memory.remember', input: NOTES[key] }] : answer('Ok.')
  })
  await signIn(page)
  const dock = page.locator('.mimir-dock')
  await expect(dock).toBeVisible()
  const again = dock.getByRole('button', { name: 'New conversation' })
  if (await again.isVisible()) await again.click()
  return dock
}

/** Asks for a note to be kept and returns the chip that offers it. */
async function askToRemember(dock: Locator, page: Page, key: string, text: string): Promise<Locator> {
  await askDock(page, `Remember ${key}: ${text}`)
  const chip = dock.getByTestId('mimir-remember').filter({ hasText: text }).last()
  await expect(chip).toBeVisible({ timeout: 30_000 })
  return chip
}

/** Settings opened on the Memory section. */
async function openMemory(page: Page): Promise<Locator> {
  await page.evaluate(() => (window as unknown as { __sx: { setState(s: Record<string, unknown>): void } }).__sx.setState({ settingsOpen: true, settingsSection: 'memory' }))
  const memory = page.locator('.mem-sec')
  await expect(memory).toBeVisible()
  return memory
}

/** What a test leaves behind for the next one on this page. */
async function putAway(page: Page): Promise<void> {
  await closeDialogs(page)
  await page.evaluate(() => {
    localStorage.setItem('sx-mimir-dock', '0')
    sessionStorage.removeItem('sx-e2e-memory-sync')
  })
}

/** Everything the section shows sits inside the screen: no sideways scroll, and no control past an edge. */
async function fitsThePhone(page: Page, memory: Locator): Promise<void> {
  await noHorizontalScroll(page)
  const width = page.viewportSize()!.width
  expect(await memory.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
  for (const control of await memory.locator('button, [role="switch"], .mem-field').all()) {
    const box = await control.boundingBox()
    if (!box) continue
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
  }
}

journey.describe('what mimir remembers on a phone', () => {
  journey.skip(({ isMobile }) => !isMobile, 'The phone project')

  journey('Remember on the chip saves the note, and the chip keeps its size', async ({ page }) => {
    const dock = await openChat(page)
    const chip = await askToRemember(dock, page, 'petg', KEPT)
    await expect(dock).not.toContainText('needs your approval')
    await noHorizontalScroll(page)
    const before = (await chip.boundingBox())!
    expect(before.x).toBeGreaterThanOrEqual(0)
    expect(before.x + before.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await chip.getByTestId('mimir-remember-yes').click()
    await expect(chip).toHaveAttribute('data-done', 'saved')
    await expect(dock).toContainText('Noted.', { timeout: 30_000 })
    expect((await chip.boundingBox())!.height).toBe(before.height)
    // the note is kept: Settings lists it
    const memory = await openMemory(page)
    await expect(memory.getByRole('list', { name: 'Filaments' })).toContainText(KEPT)
    await putAway(page)
  })

  journey('Not now on the chip keeps nothing', async ({ page }) => {
    const dock = await openChat(page)
    const chip = await askToRemember(dock, page, 'nozzle', SKIPPED)
    await chip.getByTestId('mimir-remember-no').click()
    await expect(chip).toHaveAttribute('data-done', 'dropped')
    // nothing was kept: Settings does not list the note
    const memory = await openMemory(page)
    await expect(memory).not.toContainText(SKIPPED)
    await putAway(page)
  })

  journey('Settings, Memory lists the notes, deletes one, shows the sync switch, and fits the screen', async ({ page }) => {
    const dock = await openChat(page, { account: true })
    const chip = await askToRemember(dock, page, 'a1', DELETED)
    await chip.getByTestId('mimir-remember-yes').click()
    await expect(chip).toHaveAttribute('data-done', 'saved')
    const memory = await openMemory(page)
    const notes = memory.getByRole('list', { name: 'Printers' }).getByRole('listitem').filter({ hasText: DELETED })
    await expect(notes.first()).toBeVisible()
    const had = await notes.count()
    await expect(memory.getByTestId('memory-without-asking')).toBeVisible()
    const sync = memory.getByTestId('memory-sync')
    await expect(sync).toBeVisible({ timeout: 30_000 })
    await fitsThePhone(page, memory)
    await expect(memory.getByTestId('memory-export')).toBeEnabled()
    // the sync switch turns on in place
    const at = (await sync.boundingBox())!
    await sync.click()
    await expect(sync).toHaveAttribute('aria-checked', 'true')
    expect((await sync.boundingBox())!).toEqual(at)
    // one note goes: Delete needs no confirm, and the toast offers Undo
    await memory.getByRole('button', { name: `Delete "${DELETED}"` }).first().click()
    await expect(notes).toHaveCount(had - 1)
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
    await fitsThePhone(page, memory)
    await putAway(page)
  })
})
