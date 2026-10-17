// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A journey is one spec file per feature area (e2e/journeys/). Its tests share one page per worker: the app boots and
// loads the example plate once, and every test after the first starts on the page the last one left. So each test
// sets up the state it needs itself (a fresh box, an emptied plate, an opened file) instead of counting on a fresh
// boot. A test that fails ends the worker, and the next test boots a fresh page.
//
// The page starts with stored preferences, so setup does not open: `journeyPrefs` (set per file with
// `journey.use({ journeyPrefs: { ... } })`, default the Slice tab in Advanced with mimir off, as cad-helpers.ts seeds
// it) is written before the first load only, so a test that changes a preference and reloads finds its change.
//
// The toast card takes presses while it is up, and the page lives for the whole worker, so what an earlier test left on
// it would sit over the 3D view of the tests after it. Each test starts with the card clear of two things (the `page`
// fixture): a warning or an error, which stays until it is dismissed, and a wait that never ends. The card's time waits
// while a button on it has focus, and a button taken off the card while it has focus (a toast's action, once pressed)
// never says it lost it, so a line left beside it stayed on the card for minutes with nothing hovering or focusing it.
//
// A test that needs a cold start of its own (fresh storage, a held chunk, a reload policy) uses `test` from
// fixtures.ts, not this.
import type { BrowserContextOptions, Page } from '@playwright/test'
import { interceptFileDialogs } from './file-dialog'
import { COLD_START_MS, plateReady, prepareContext, preparePage, test } from './fixtures'

export type JourneyOptions = { journeyPrefs: Record<string, unknown> }

export const journey = test.extend<object, JourneyOptions & { app: Page }>({
  journeyPrefs: [{ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }, { scope: 'worker', option: true }],
  app: [
    async ({ browser, journeyPrefs }, use, worker) => {
      // The project's own page options (desktop or phone size, touch, the app's address), as a test's page gets them.
      const use_ = worker.project.use as BrowserContextOptions
      const keys = ['viewport', 'isMobile', 'hasTouch', 'baseURL', 'deviceScaleFactor'] as const
      const options = Object.fromEntries(keys.filter((k) => use_[k] !== undefined).map((k) => [k, use_[k]])) as BrowserContextOptions
      const context = await browser.newContext(options)
      await prepareContext(context)
      // `sx-e2e` marks a test session (the app opens its right pane for one) and seeds the prefs on the first load only.
      // `slicerx.debug` puts the store (`__sx`) and the view (`__vp`) on the window; the app reads it as it loads, so it
      // goes in before every load, or a test that clears storage and reloads loses the hooks.
      await context.addInitScript((prefs) => {
        localStorage.setItem('slicerx.debug', '1')
        if (sessionStorage.getItem('sx-e2e')) return
        sessionStorage.setItem('sx-e2e', '1')
        localStorage.setItem('slicerx.prefs.v1', JSON.stringify(prefs))
      }, journeyPrefs)
      const page = await context.newPage()
      await preparePage(page)
      // File dialogs are intercepted from before the first load (file-dialog.ts explains the race), so any journey test
      // can open one; a later interceptFileDialogs call on this page does nothing.
      interceptFileDialogs(page)
      await page.goto('./')
      await plateReady(page)
      await use(page)
      await context.close()
    },
    { scope: 'worker', timeout: COLD_START_MS + 60_000 },
  ],
  page: async ({ app }, use) => {
    const dismiss = app.getByTestId('toast-dismiss')
    for (let i = 0; i < 10 && (await dismiss.count()) > 0; i++) await dismiss.first().click({ timeout: 5_000 }).catch(() => undefined)
    // Says that focus left the card, so a time held for a button that is gone runs on.
    await app.evaluate(() => void document.querySelector('.sx-toasts')?.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await use(app)
  },
})

export { expect } from './fixtures'
