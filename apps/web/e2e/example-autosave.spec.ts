// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The example plate a session starts with is no one's work: it is never autosaved, and an autosave of it that an
// earlier version left (0.2.3 wrote one at every start) is dropped instead of offered back after an upgrade.
import { type Page } from '@playwright/test'
import { openStudio } from './cad-helpers'
import { expect, plateReady, test } from './fixtures'

/** Notes whether "Restore unsaved work?" ever showed, since the fixtures dismiss it as soon as it does. */
async function watchRestore(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __restoreShown: boolean }
    w.__restoreShown = false
    new MutationObserver(() => {
      if (document.body?.textContent?.includes('Restore unsaved work?')) w.__restoreShown = true
    }).observe(document, { childList: true, subtree: true, characterData: true })
  })
}

const restoreShown = (page: Page) => page.evaluate(() => (window as unknown as { __restoreShown: boolean }).__restoreShown)

/** The rows of the app's project storage. */
function rows(page: Page): Promise<{ id: string; name: string; v?: number }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('slicerx-projects', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('snapshots', { keyPath: 'id' })
        req.onsuccess = () => {
          const all = req.result.transaction('snapshots').objectStore('snapshots').getAll()
          all.onsuccess = () => resolve((all.result as { id: string; name: string; v?: number }[]).map(({ id, name, v }) => ({ id, name, ...(v ? { v } : {}) })))
          all.onerror = () => reject(all.error)
        }
        req.onerror = () => reject(req.error)
      }),
  )
}

/** Writes an autosave row the way an earlier version did: no version stamp. */
function putOldAutosave(page: Page, name: string): Promise<void> {
  return page.evaluate(
    (n) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('slicerx-projects', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('snapshots', { keyPath: 'id' })
        req.onsuccess = () => {
          const tx = req.result.transaction('snapshots', 'readwrite')
          tx.objectStore('snapshots').put({ id: 'autosave', name: n, savedAt: Date.now(), objects: 1, data: new Uint8Array([1]) })
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      }),
    name,
  )
}

test.describe('the example plate and the autosave', () => {
  test.skip(({ isMobile }) => isMobile, 'Storage, not layout')

  test('the untouched example plate is never autosaved, so a reload offers nothing back', async ({ page }) => {
    test.slow()
    await watchRestore(page)
    await openStudio(page)
    // Past the autosave's delay, with the start's own changes (presets, the printer's bed) settled.
    await page.waitForTimeout(9000)
    expect((await rows(page)).filter((r) => r.id === 'autosave')).toEqual([])
    await page.reload()
    await plateReady(page)
    await page.waitForTimeout(1500)
    expect(await restoreShown(page)).toBe(false)
  })

  test("an earlier version's autosave of the example plate is dropped, and other work is still offered", async ({ page }) => {
    test.slow()
    await watchRestore(page)
    await openStudio(page)
    await putOldAutosave(page, 'Layered_X.sx3mf')
    await page.reload()
    await plateReady(page)
    await expect.poll(() => rows(page).then((r) => r.filter((x) => x.id === 'autosave'))).toEqual([])
    expect(await restoreShown(page)).toBe(false)
    // The same kind of leftover with other work in it is offered back.
    await putOldAutosave(page, 'bracket.sx3mf')
    await page.reload()
    await expect.poll(() => restoreShown(page), { timeout: 30_000 }).toBe(true)
  })
})
