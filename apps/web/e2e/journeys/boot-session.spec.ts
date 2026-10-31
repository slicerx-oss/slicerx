// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How the app starts and the first things a session does. Two kinds of test live here. The main flows of the browser
// build run on the page the worker shares, since the app is up for them. Everything about a start itself (first-run
// setup on a fresh install, a script chunk that fails to download, a reload policy, a held icon table, a required
// update) needs a cold start of its own and keeps the per-test page. The phone legs are in phone-session.spec.ts.
//
// Dropped because a unit test has them: the "at least 30 commands" count (packages/app/test/commands.test.ts:28),
// first-run's mimir cloud sign-in cards in the browser (packages/app/test/first-run-mimir.test.ts:62 and :81), and the
// old example autosave being dropped or still offered when it is real work (packages/app/test/autosave.test.ts:108
// and :115).
import { test as plain, expect as plainExpect } from '@playwright/test'
import { type Page } from '@playwright/test'
import { journey, expect } from '../journey'
import { openStudio } from '../cad-helpers'
import { COLD_START_MS, expectCurrentTab, expectTabLabel, goTab, plateReady, test as cold } from '../fixtures'
import {
  A1_MINI,
  cadOnlyStudio,
  escapeAndHandAdd,
  freshSetup,
  iconsWithoutTable,
  mimirConnectSteps,
  noHorizontalScroll,
  printersFleet,
  setupSteps,
  settingsAccount,
  shotsDir,
  shotsOn,
  sliceAndColorBy,
  themeAndLookAndFeel,
  vaultFeed,
  workspaceNeverDownloads,
} from './lib/session'

/* ------------------------------------------------------------------ the app, up */

// Worker options go at the top of the file. The cold tests below take no journey page, so they do not read this.
journey.use({ journeyPrefs: { workspace: 'prepare', settingsMode: 'advanced', cadTools: true } })

journey.describe('the main flows of the browser build', () => {
  journey.skip(({ isMobile }) => isMobile, 'Desktop. The phone legs are in phone-session.spec.ts')

  journey('the reference plate loads on the plate tab', async ({ page }) => {
    await goTab(page, 'prepare')
    await plateReady(page)
    await expect(page.getByText('Layered X', { exact: true }).first()).toBeVisible()
    await noHorizontalScroll(page)
  })

  journey('Cmd+K opens from every workspace and goes where it is told', async ({ page }) => {
    for (const id of ['prepare', 'feed', 'printers']) {
      await goTab(page, id)
      await page.keyboard.press('ControlOrMeta+k')
      await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible()
      await page.keyboard.press('Escape')
    }
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('go printers')
    await page.keyboard.press('Enter')
    await expectCurrentTab(page, 'printers', 'Printers')
  })

  journey('free text in Cmd+K goes to the mimir tab', async ({ page }) => {
    await goTab(page, 'prepare')
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('why is my first layer peeling')
    await expect(page.locator('.sx-palette-item', { hasText: 'Ask mimir: why is my first layer peeling' })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('tab-mimir')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('mimir-chat')).toContainText('why is my first layer peeling')
    // back to the plate for the next test
    await goTab(page, 'prepare')
  })

  journey('Slice runs and shows the layers in place', async ({ page }) => {
    await sliceAndColorBy(page, false)
  })

  journey('Printers shows the demo fleet', async ({ page }) => {
    await printersFleet(page)
  })

  journey('the Vault shows a featured design and rows, opens creators, and switches between Feed and Saved', async ({ page }) => {
    await vaultFeed(page)
  })

  journey('Settings opens with Account and Phone access', async ({ page }) => {
    await settingsAccount(page)
  })

  journey('side panes collapse to a rail and remember it', async ({ page }) => {
    await goTab(page, 'prepare')
    // the pane's edge tab: Close while it is open, Open once it is a rail
    const edge = (verb: 'Close' | 'Open') => page.getByRole('button', { name: new RegExp(`^${verb} Printer and settings`) })
    const rail = () => page.locator('.sx-rail[data-side=left]')
    try {
      await edge('Close').click()
      // Move away so the hover peek does not reopen the rail.
      await page.mouse.move(700, 450)
      await expect(rail()).toHaveAttribute('data-collapsed', 'true')
      await page.reload()
      await expect(rail()).toHaveAttribute('data-collapsed', 'true')
    } finally {
      // the choice is remembered, so open the pane again for the tests after this one
      if (await edge('Open').isVisible()) await edge('Open').click()
      await page.mouse.move(700, 450)
      await expect(rail()).not.toHaveAttribute('data-collapsed', 'true')
    }
  })

  journey('About shows the attribution line, the license and the source link', async ({ page }) => {
    await goTab(page, 'prepare')
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type('About SlicerX and its source code')
    await page.locator('.sx-palette-item', { hasText: 'About SlicerX and its source code' }).first().click()
    const about = page.getByRole('dialog', { name: /About/ })
    // The edition's attribution: "Made possible by SlicerX", linking to the support page.
    const credit = about.getByTestId('about-attribution')
    await expect(credit).toHaveText('Made possible by SlicerX')
    await expect(credit.getByRole('link', { name: 'Made possible by SlicerX' })).toHaveAttribute('href', 'https://slicerx.app/support')
    await expect(about.getByText(/Apache-2\.0; stock printer profiles AGPL-3\.0-or-later/)).toBeVisible()
    // The license's source offer: the tree of exactly this build.
    await expect(about.getByText(/The source for exactly this build is at/)).toBeVisible()
    const source = about.getByRole('link', { name: /github\.com\/slicerx-oss\/slicerx\/tree\// })
    await expect(source).toBeVisible()
    await expect(source).toHaveAttribute('href', /^https:\/\/github\.com\/slicerx-oss\/slicerx\/tree\/\S+$/)
    // The LGPL notice for the STEP reader, with the Open CASCADE exception's acknowledgment.
    await expect(about.getByTestId('about-step-reader')).toContainText('makes use of facilities provided by the Open CASCADE Technology software')
    await page.keyboard.press('Escape')
    await expect(about).toHaveCount(0)
  })
})

/* ------------------------------------------------------------------ the example plate and the autosave (cold) */

cold.describe('the example plate and the autosave', () => {
  cold.skip(({ isMobile }) => isMobile, 'Storage, not layout')

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
  const rows = (page: Page): Promise<{ id: string; name: string }[]> =>
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('slicerx-projects', 1)
          req.onupgradeneeded = () => req.result.createObjectStore('snapshots', { keyPath: 'id' })
          req.onsuccess = () => {
            const all = req.result.transaction('snapshots').objectStore('snapshots').getAll()
            all.onsuccess = () => resolve((all.result as { id: string; name: string }[]).map(({ id, name }) => ({ id, name })))
            all.onerror = () => reject(all.error)
          }
          req.onerror = () => reject(req.error)
        }),
    )

  // The example plate a session starts with is no one's work: it is never autosaved. (An old autosave of it being
  // dropped, and other work being offered back, is packages/app/test/autosave.test.ts:108 and :115.)
  cold('the untouched example plate is never autosaved, so a reload offers nothing back', async ({ page }) => {
    // The autosave waits 4 s after the last change (AUTOSAVE_DELAY_MS). The page's clock jumps over that wait, so the
    // test does not sit through it.
    await watchRestore(page)
    await page.clock.install()
    await openStudio(page)
    await page.clock.fastForward(10_000)
    // a write that was going to happen lands within a moment of the timer: look a few times, not once
    for (let i = 0; i < 4; i++) {
      expect((await rows(page)).filter((r) => r.id === 'autosave')).toEqual([])
      await page.waitForTimeout(150)
    }
    await page.reload()
    await plateReady(page)
    await page.clock.fastForward(3_000)
    expect(await restoreShown(page)).toBe(false)
  })
})

/* ------------------------------------------------------------------ icons */

cold.describe('icons', () => {
  cold('the prepare workspace draws every icon without the full icon table', { tag: '@smoke' }, async ({ page }, info) => {
    await iconsWithoutTable(page, info)
  })
})

/* ------------------------------------------------------------------ loading and a network that changes */

cold.describe('a part of the app that loads slowly', () => {
  cold.skip(({ isMobile }) => isMobile, 'The top bar tabs are a desktop control')
  type Sx = { setState(p: unknown): void }

  /** Holds back every script the page asks for from now on, until `release` is called. */
  async function holdScripts(page: Page): Promise<() => void> {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    await page.route(/\/static\/[^/]+\.js$/, async (route) => {
      await gate
      await route.continue()
    })
    return release
  }
  async function open(page: Page): Promise<void> {
    await page.addInitScript(() => {
      localStorage.setItem('slicerx.debug', '1')
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
    })
    await page.goto('./')
    await plateReady(page)
  }

  // A part of the app that loads slowly says so: the space it will fill shows a sheen and, after a moment, the word
  // Loading, in both themes, instead of reading as an empty page.
  cold('a workspace that loads slowly shows Loading, then its page', async ({ page }) => {
    await open(page)
    const release = await holdScripts(page)
    await page.getByTestId('tab-printers').click()
    const loading = page.getByRole('status').filter({ hasText: 'Loading' })
    await expect(loading).toBeVisible()
    // The word waits a moment, so a quick load never flashes it, then reads clearly.
    await expect.poll(() => loading.locator('span').evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1)
    release()
    // The workspace's code lands, then its page mounts. On a loaded runner that mount can hold the page for longer than
    // a default wait, so the page's own heading is awaited with the cold start's allowance, and the fallback must be gone
    // once it is there.
    await expect(page.getByRole('heading', { name: 'Printers', level: 1 })).toBeVisible({ timeout: COLD_START_MS })
    await expect(loading).toHaveCount(0)
  })

  // Model's ribbon loads on the first open of Model. Until it lands, an empty ribbon of its height holds its place: a
  // 1 px placeholder let the view jump 111 px down when the tools arrived, so a box select started then missed (#1225).
  cold("Model's ribbon holds its place while its code loads, and the view does not move when it arrives", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page)
    const release = await holdScripts(page)
    await page.locator('.sx-tab[data-mode="design"]').click()
    const ribbon = page.locator('.studio > .ribbon')
    await expect(ribbon).toHaveAttribute('aria-hidden', 'true')
    const view = page.locator('.vp-canvas').first()
    const waiting = { ribbon: (await ribbon.boundingBox())!, view: (await view.boundingBox())! }
    release()
    await expect(page.getByTestId('model-shelf')).toBeVisible()
    expect((await ribbon.boundingBox())!.height).toBeCloseTo(waiting.ribbon.height, 1)
    expect(await view.boundingBox()).toEqual(waiting.view)
  })

  // Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
  cold.describe('shots', () => {
    cold.skip(!shotsOn(), 'SX_SHOTS=1 only')
    cold('shots: a slow workspace load, light and dark', async ({ page }, info) => {
      cold.slow()
      const dir = shotsDir(info)
      for (const width of [1440, 1100]) {
        for (const scheme of ['light', 'dark'] as const) {
          // A page of its own each time, so the workspace's scripts are not loaded yet.
          const p = await page.context().newPage()
          await p.setViewportSize({ width, height: 860 })
          await open(p)
          await p.evaluate((s) => (window as unknown as { __sx: Sx }).__sx.setState({ scheme: s, themeFollowsSystem: false }), scheme)
          const release = await holdScripts(p)
          await p.getByTestId('tab-printers').click()
          await p.waitForTimeout(900)
          await p.mouse.move(0, 0)
          await p.screenshot({ path: `${dir}/loading-${scheme}-${width}.png` })
          release()
          await p.close()
        }
      }
    })
  })
})

// The cold start waits load the page again when the computer's network changes under it (fixtures.ts, untilReady):
// Chrome drops every request in flight then, loopback ones too, and a start that loses its script chunks never comes
// up. A Wi-Fi roam on the GPU runner did that to four pages at once in a merge queue run. Here the first load loses
// every chunk the app loads after its entry, the way that roam did, and the start still reaches the plate.
cold.describe('a network that changes', () => {
  cold.skip(({ isMobile }) => isMobile, 'Layout does not matter to a start')
  cold('a cold start whose script chunks the network dropped loads again and reaches the plate', async ({ page }) => {
    // A profile past first-run setup, with a printer, as the shell journey starts.
    await page.addInitScript((a1) => {
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' }, handPrinters: [a1], printerId: a1.id }))
    }, A1_MINI)
    // The page's own scripts load; every chunk it asks for later is dropped, on the first load only.
    const html = await (await page.request.get('./')).text()
    const eager = new Set([...html.matchAll(/static\/[\w.-]+\.js/g)].map((m) => m[0]))
    let loads = 0
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) loads++
    })
    const dropped: string[] = []
    await page.route(/\/static\/[\w.-]+\.js$/, async (route) => {
      const file = /static\/[\w.-]+\.js$/.exec(route.request().url())?.[0] ?? ''
      if (loads > 1 || eager.has(file)) return route.fallback()
      dropped.push(file)
      return route.abort('internetdisconnected')
    })
    await page.goto('./')
    await plateReady(page)
    expect(dropped.length).toBeGreaterThan(0)
    expect(loads).toBe(2)
  })
})

/* ------------------------------------------------------------------ a required update */

// A required update (the feed's min_version above this version) holds the app: Escape does not close the sheet, no
// shortcut reaches the app behind it, and only Quit or Update now answer it. The e2e build reads the feed from the page
// once, as it starts, so the page cannot be shared: the sheet stays up over it.
cold.describe('a required update', () => {
  cold.skip(({ isMobile }) => isMobile, 'Runs at desktop width')
  cold('the required update sheet ignores Escape and holds every key', async ({ page }) => {
    await page.addInitScript(() => {
      ;(window as unknown as { __sxUpdateFeed: unknown }).__sxUpdateFeed = { version: '9.9.9', notes: 'A fix for a known problem.', minVersion: '9.9.9', required: true }
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
    })
    await page.goto('./')
    await plateReady(page)
    const sheet = page.getByRole('dialog').filter({ hasText: 'This version has a known problem' })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('button', { name: 'Later' })).toHaveCount(0)
    // Escape, pressed again and again: Chromium closes a dialog on a second Escape unless the page stops it.
    for (let i = 0; i < 3; i++) await page.keyboard.press('Escape')
    await expect(sheet).toBeVisible()
    // WebView2 closed it on Escape with nothing clicked yet (no user activation, so no cancel event to stop). Whatever
    // closes the native dialog, the sheet comes straight back.
    await page.evaluate(() => (document.querySelector('dialog[open]') as HTMLDialogElement).close())
    await expect(sheet).toBeVisible()
    // The app's shortcuts do nothing behind it: the command bar, the shortcuts list, removing the selected object.
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.press('Shift+?')
    await page.keyboard.press('Delete')
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect(page.locator('.obj-name', { hasText: 'Layered X' })).toHaveCount(1)
    // Tab stays inside the sheet, and its own buttons answer.
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog')))).toBe(true)
    await sheet.getByRole('button', { name: 'Quit' }).click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __sxQuit?: boolean }).__sxQuit === true)).toBe(true)
  })
})

/* ------------------------------------------------------------------ a startup script that does not download */

// A startup script that fails to download leaves no app at all: the page reloads once and comes up. Seen on a busy
// runner as net::ERR_NO_BUFFER_SPACE on a shared startup chunk, which left the page empty until the test gave up.
// The plain test, not the fixtures': their cold start wait reloads a page itself, and this checks the page's own reload.
plain.describe('a startup script that does not download', () => {
  plain.skip(({ isMobile }) => isMobile, 'Desktop start')

  for (const [what, file] of [['the entry', /\/static\/index-[^/]+\.js$/], ['a chunk the entry imports', /\/static\/jsx-runtime-[^/]+\.js$/]] as const) {
    plain(`${what}: the page reloads once and the app comes up`, async ({ page }) => {
      let dropped = 0
      await page.route(file, (route) => {
        if (dropped === 0) {
          dropped++
          return route.abort('failed')
        }
        return route.continue()
      })
      // the reload comes before the first page finishes loading, so count navigations, not load events
      let loads = 0
      page.on('framenavigated', (f) => f === page.mainFrame() && loads++)
      await page.goto('./')
      await plainExpect(page.locator('html[data-sx-ready]')).toHaveCount(1, { timeout: 120_000 })
      plainExpect(dropped).toBe(1)
      plainExpect(loads).toBe(2)
    })
  }

  plain('a script that keeps failing does not reload over and over', async ({ page }) => {
    await page.route(/\/static\/index-[^/]+\.js$/, (route) => route.abort('failed'))
    let loads = 0
    page.on('framenavigated', (f) => f === page.mainFrame() && loads++)
    await page.goto('./')
    await plainExpect.poll(() => loads).toBe(2)
    // the page gets a few seconds to prove it does not try a third time
    await page.waitForTimeout(3000)
    plainExpect(loads).toBe(2)
    await plainExpect(page.locator('html[data-sx-ready]')).toHaveCount(0)
  })
})

/* ------------------------------------------------------------------ a part of the code that fails to download */

// A part of the app's code that fails to download while the app starts (the connection drops for a moment) does not
// leave the workspace stuck: the browser keeps a failed module for the rest of the page, so the app reloads once and
// comes up with its plate.
cold.describe('code that fails to download', () => {
  cold.skip(({ isMobile }) => isMobile, 'Desktop. The phone gutter check is in phone-session.spec.ts')
  type Sx = { setState(p: unknown): void }

  cold('a workspace whose code failed to download comes back after one reload', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
    })
    let dropped = 0
    // The first fetch of the workspace's code fails as a dropped connection does; every later one goes through. A reset,
    // not a lost network: the fixtures reload a page whose network changed (NETWORK_CHANGED), and that reload would
    // race the app's own one, the reload this test is about.
    await page.route(/\/static\/studio-[^/]+\.js$/, (route) => {
      if (dropped === 0) {
        dropped++
        return route.abort('connectionreset')
      }
      return route.continue()
    })
    let loads = 0
    page.on('load', () => loads++)
    await page.goto('./')
    // The plate loads in the workspace, which only renders once its code arrived.
    await page.locator('html[data-sx-ready="plate"], html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: COLD_START_MS })
    // The plate picker names the plate in view, so the workspace is up once it reads Plate 1.
    await expect(page.getByTestId('plate-picker-current').locator('.pp-no')).toHaveText('Plate 1')
    expect(dropped).toBe(1)
    expect(loads).toBe(2)
    await expect(page.getByText('did not load')).toHaveCount(0)
  })

  cold('a workspace whose code never downloads says so once, in the workspace, with no toast over it', async ({ page }) => {
    await workspaceNeverDownloads(page, false)
  })

  cold('a dialog whose code did not download leaves the workspace up and says so in a toast', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('slicerx.debug', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
    })
    await page.route(/\/static\/about-[^/]+\.js$/, (route) => route.abort('internetdisconnected'))
    let loads = 0
    page.on('load', () => loads++)
    const ready = () => page.locator('html[data-sx-ready="plate"], html[data-sx-ready="viewport"]').waitFor({ state: 'attached', timeout: COLD_START_MS })
    const about = () => page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ aboutOpen: true }))
    await page.goto('./')
    await ready()
    // With nothing unsaved the first failure reloads the page, which fetches the code again.
    await about()
    await expect.poll(() => loads).toBe(2)
    await ready()
    // It fails again within half a minute: no second reload, a toast instead, and the workspace keeps working.
    await about()
    const toast = page.getByTestId('toast').filter({ hasText: /Part of .* did not load/ })
    await expect(toast).toBeVisible()
    await expect(toast.getByRole('button', { name: 'Reload' })).toBeVisible()
    await expect(page.getByRole('heading', { name: /did not load/ })).toHaveCount(0)
    // The plate picker names the plate in view, so the workspace is up once it reads Plate 1.
    await expect(page.getByTestId('plate-picker-current').locator('.pp-no')).toHaveText('Plate 1')
    expect(loads).toBe(2)
  })
})

/* ------------------------------------------------------------------ first-run setup (a fresh install each) */

cold.describe('first-run setup', () => {
  cold.skip(({ isMobile }) => isMobile, 'Desktop: the full setup with Opens in. The phone legs are in phone-session.spec.ts')

  cold('the scan finds the printer, the connection tests itself, then the slicer question', async ({ page }) => {
    await freshSetup(page)
    await noHorizontalScroll(page)

    // Nothing is searched until asked; then the scan lists what the demo network announces, with what each printer reported.
    await expect(page.getByRole('radiogroup', { name: 'Printers found' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Search my network' }).click()
    const found = page.getByRole('radiogroup', { name: 'Printers found' }).getByRole('radio')
    await expect(found).toHaveCount(6)
    const x1 = found.filter({ hasText: 'X1 Carbon' })
    await expect(x1).toContainText('AMS')
    await expect(x1).toContainText('192.0.2.11')
    await x1.click()
    await expect(x1).toHaveAttribute('aria-checked', 'true')

    // Bambu LAN asks for the serial number and the access code; the test starts once both are in.
    await page.getByRole('textbox', { name: /Serial number/ }).fill('01S00A987654321')
    const code = page.getByRole('textbox', { name: /Access code/ })
    await code.fill('12345678')
    // The access code is read off a screen, not a password: shown as typed.
    await expect(code).toHaveAttribute('type', 'text')
    await expect(page.locator('.fr-found-ok')).toContainText('Found it.')
    await expect(page.locator('.fr-test .fr-ok')).toContainText('Connected')
    // A test past 1.2 s lands the ravens on a trail of three rows instead of the list of four steps (a slower runner
    // gets the trail): either way, every row passed.
    const rows = page.locator('.fr-checks li, .fr-trail li')
    await expect(rows.first()).toBeVisible()
    await expect(rows).toHaveCount((await page.locator('.fr-trail').count()) > 0 ? 3 : 4)
    await expect(page.locator('.fr-checks li:not([data-state="ok"]), .fr-trail li:not([data-state="ok"])')).toHaveCount(0)
    await expect(page.locator('.fr-read')).toContainText('X1 Carbon')
    await expect(page.locator('.fr-read')).toContainText('AMS')
    await noHorizontalScroll(page)
    await page.locator('.fr-foot').getByRole('button', { name: 'Continue' }).click()

    // Which slicer: four cards, "something else" preselected, the pick applied live.
    await expect(page.locator('#fr-step-label')).toHaveText('Step 3 of 5')
    await expect(page.getByRole('heading', { name: 'Which slicer do you use now?' })).toBeVisible()
    const cards = page.getByRole('radiogroup', { name: 'Slicer you use now' }).getByRole('radio')
    await expect(cards).toHaveCount(4)
    await expect(cards.nth(0)).toContainText('Bambu Studio')
    await expect(cards.nth(1)).toContainText('OrcaSlicer')
    await expect(cards.nth(2)).toContainText('PrusaSlicer')
    await expect(cards.nth(3)).toHaveAttribute('aria-checked', 'true')
    await cards.nth(0).click()
    await expect(cards.nth(0)).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'bambu-studio')
    await expect(page.getByText('Bring your Bambu Studio presets')).toBeVisible()
    await expect(page.getByText('SlicerX is not affiliated with them.', { exact: false })).toBeVisible()
    // Arrow keys move the selection.
    await cards.nth(0).press('ArrowDown')
    await expect(cards.nth(1)).toHaveAttribute('aria-checked', 'true')
    await cards.nth(1).press('ArrowUp')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'bambu-studio')
    // The settings mode, prefilled: a fresh install starts in Simple.
    await expect(page.getByTestId('setup-mode-simple')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText('Change it any time from the chip at the top of the Slice sidebar.')).toBeVisible()
    await noHorizontalScroll(page)
    await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()

    // Then what the plate tab opens in: Slicing stays chosen.
    await expect(page.locator('#fr-step-label')).toHaveText('Step 4 of 5')
    await expect(page.getByRole('heading', { name: /What do you want .* to open in\?/ })).toBeVisible()
    await expect(page.getByRole('radio', { name: /^Slicing/ })).toHaveAttribute('aria-checked', 'true')
    await noHorizontalScroll(page)
    await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()

    // Then mimir: setting it up is offered, and the plate opens from there.
    await expect(page.locator('#fr-step-label')).toHaveText('Step 5 of 5')
    await expect(page.getByRole('heading', { name: 'Set up mimir' })).toBeVisible()
    await noHorizontalScroll(page)
    await page.locator('.fr-foot').getByRole('button', { name: 'Open the plate' }).click()
    await expect(page.locator('.fr')).toHaveCount(0)

    // The Bambu style names the Printers workspace Device and keeps the choice and the printer.
    await expectTabLabel(page, 'printers', 'Device')
    const stored = await page.evaluate(() => localStorage.getItem('slicerx.prefs.v1') ?? '')
    const prefs = JSON.parse(stored) as { lookAndFeel: { id: string }; firstRun: { completedAt: string | null; printerId: string | null } }
    expect(prefs.lookAndFeel.id).toBe('bambu-studio')
    expect(prefs.firstRun.completedAt).not.toBeNull()
    expect(prefs.firstRun.printerId).toBe('bay-1')
    // The access code never lands in storage.
    const all = await page.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join('\n'))
    expect(all).not.toContain('12345678')

    await page.reload()
    await expectTabLabel(page, 'printers', 'Device')
    await expect(page.getByRole('heading', { name: 'Find your printer' })).toHaveCount(0)
  })

  // One fresh install through the steps that do not need a start of their own: Escape asks before leaving, a printer
  // added by hand names a failed test's cause and goes on, Settings brings the slicer screen back, choosing CAD model
  // opens the plate in Model (now, on the next launch, and Settings changes it), and mimir offers its connect step
  // until a model is connected.
  cold('Escape asks, a hand added printer goes on untested, CAD model opens the plate in Model, and mimir offers its connect step', async ({ page }) => {
    await escapeAndHandAdd(page, false)
    await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
    await expect(page.locator('#fr-step-label')).toHaveText(`Step 4 of ${setupSteps(false)}`)
    const cad = page.getByRole('radio', { name: /^CAD model/ })
    await cad.click()
    await expect(cad).toHaveAttribute('aria-checked', 'true')
    await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
    await page.locator('.fr-foot').getByRole('button', { name: 'Open the plate' }).click()
    await expect(page.locator('.fr')).toHaveCount(0)
    await expect(page.locator('.sx-tab[data-mode="design"]')).toHaveAttribute('aria-current', 'page')
    await page.reload()
    await expect(page.locator('.sx-tab[data-mode="design"]')).toHaveAttribute('aria-current', 'page')
    // Settings > Look and feel changes the default; the session stays where it is.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Look and feel' }).click()
    const row = page.getByRole('radiogroup', { name: 'Open models in' })
    await expect(row.getByRole('radio', { name: 'Model' })).toHaveAttribute('aria-checked', 'true')
    await row.getByRole('radio', { name: 'Slicing' }).click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.sx-tab[data-mode="design"]')).toHaveAttribute('aria-current', 'page')
    await page.reload()
    await expect(page.locator('.sx-tab[data-mode="slice"]')).toHaveAttribute('aria-current', 'page')
    await mimirConnectSteps(page, false)
  })

  cold('a first setup quit partway records the onboarding version, and the next launch opens the app, not setup again', async ({ page }) => {
    await freshSetup(page)
    const stored = async () => JSON.parse((await page.evaluate(() => localStorage.getItem('slicerx.prefs.v1'))) ?? '{}') as { firstRun?: Record<string, unknown> }
    await expect.poll(async () => (await stored()).firstRun).toMatchObject({ completedAt: null, step: 'printer', version: 4 })
    // Quitting here and opening the app again: no setup by itself; Settings still offers to finish it. A quit ends the
    // tab's session; a plain reload keeps it and comes back to setup on purpose.
    // slicerx.debug puts the store on window as __sx for the check below
    await page.evaluate(() => {
      sessionStorage.clear()
      localStorage.setItem('slicerx.debug', '1')
    })
    await page.reload()
    await page.locator('html[data-sx-ready]').waitFor({ state: 'attached' })
    // setup is lazy, so no .fr yet proves nothing on its own: the store says whether it is open
    expect(await page.evaluate(() => (window as unknown as { __sx: { getState(): { setup: unknown } } }).__sx.getState().setup)).toBeNull()
    await expect(page.locator('.fr')).toHaveCount(0)
    expect((await stored()).firstRun).toMatchObject({ completedAt: null, step: 'printer', version: 4 })
  })

  // Screenshots for review: SX_SHOTS=1, saved to SX_SHOTS_DIR (test-results/shots by default).
  cold.describe('shots', () => {
    cold.skip(!shotsOn(), 'SX_SHOTS=1 only')
    cold('shots: the launch after a first setup quit partway, light and dark', async ({ page }, info) => {
      const dir = shotsDir(info)
      const width = page.viewportSize()?.width ?? 0
      await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
      await freshSetup(page)
      await page.reload()
      await page.locator('html[data-sx-ready]').waitFor({ state: 'attached' })
      for (const scheme of ['light', 'dark'] as const) {
        await page.evaluate((s) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ scheme: s, themeFollowsSystem: false }), scheme)
        await page.mouse.move(0, 0)
        await page.waitForTimeout(600)
        await page.screenshot({ path: `${dir}/setup-quit-relaunch-${scheme}-${width}.png` })
      }
    })

    cold('shots: the settings mode question in the slicer step, light and dark', async ({ page }, info) => {
      const dir = shotsDir(info)
      const width = page.viewportSize()?.width ?? 0
      await page.addInitScript(() => localStorage.setItem('slicerx.debug', '1'))
      await page.addInitScript(() => {
        if (localStorage.getItem('sx-e2e-seeded')) return
        localStorage.setItem('sx-e2e-seeded', '1')
        localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', printerId: 'bay-1', settingsMode: 'advanced', firstRun: { completedAt: '2026-10-07T00:00:00.000Z', step: 'done', look: { id: 'slicerx' }, printerId: 'bay-1', version: 2 } }))
      })
      await page.goto('./')
      await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
      await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
      const question = page.getByRole('group', { name: 'Settings mode' })
      await expect(question).toBeVisible()
      for (const scheme of ['light', 'dark'] as const) {
        await page.evaluate((s) => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ scheme: s, themeFollowsSystem: false }), scheme)
        await question.evaluate((el) => el.scrollIntoView({ block: 'center' }))
        await page.mouse.move(0, 0)
        await page.waitForTimeout(400)
        await page.screenshot({ path: `${dir}/setup-mode-${scheme}-${width}.png` })
      }
    })
  })

  cold('the theme step applies at once and stays after a reload, and Settings, Look and feel carries the same choices', async ({ page }) => {
    await themeAndLookAndFeel(page)
  })

  // Two profiles from earlier onboardings on one page: the second is written over the first and the app loaded again.
  cold('a profile from an earlier onboarding goes through setup again, prefilled, and keeps everything', async ({ page }) => {
    await page.addInitScript(() => {
      // The real default for a saved on is Auto: without the test fixture's Always.
      sessionStorage.removeItem('sx-auto-slice-always')
      if (localStorage.getItem('sx-e2e-seeded')) return
      localStorage.setItem('sx-e2e-seeded', '1')
      // As 0.2.2 left it: setup finished with no version, the old SlicerX theme ids, the Bambu look, a printer, slicing on open.
      localStorage.setItem(
        'slicerx.prefs.v1',
        JSON.stringify({ workspace: 'prepare', printerId: 'bay-1', scheme: 'dark', themeIds: { dark: 'slicerx-dark', light: 'slicerx-light' }, lookAndFeel: { id: 'bambu-studio' }, toolpathPalette: 'colorblind', modelModeDefault: 'slice', settingsMode: 'advanced', autoSlice: true, firstRun: { completedAt: '2026-10-01T00:00:00.000Z', step: 'done', look: { id: 'bambu-studio' }, printerId: 'bay-1' } }),
      )
    })
    await page.goto('./')
    // Pre-alpha: everyone runs it again, from the theme, with their choices filled in.
    await expect(page.getByRole('heading', { name: 'Pick a theme' })).toBeVisible()
    await expect(page.locator('#fr-step-label')).toHaveText(/^Step 1 of \d$/)
    await expect(page.getByTestId('theme-subban')).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-sx-theme', 'subban-dark')
    await expect(page.getByRole('region', { name: 'Easier to read' }).getByRole('radio', { name: 'Red-green' })).toHaveAttribute('aria-checked', 'true')
    await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
    // The printer they have is kept with one click.
    await expect(page.getByRole('heading', { name: 'Your printer' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Your printers' }).locator('li').first()).toContainText('Slices for this one')
    await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
    await expect(page.getByRole('radiogroup', { name: 'Slicer you use now' }).getByRole('radio', { name: /Bambu Studio/ })).toHaveAttribute('aria-checked', 'true')
    // The settings mode question is new in this onboarding, prefilled with the mode they use.
    await expect(page.getByTestId('setup-mode-advanced')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('setup-mode-expert').click()
    await expect(page.getByTestId('setup-mode-expert')).toHaveAttribute('aria-checked', 'true')
    // So is the auto slice question: their saved on reads as Auto, the new default.
    await expect(page.getByTestId('setup-autoslice-auto')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('setup-autoslice-always').click()
    await page.getByRole('button', { name: 'Skip, use defaults' }).click()
    await expect(page.locator('.fr')).toHaveCount(0)
    const prefs = JSON.parse((await page.evaluate(() => localStorage.getItem('slicerx.prefs.v1'))) ?? '{}') as Record<string, unknown>
    expect(prefs).toMatchObject({ printerId: 'bay-1', lookAndFeel: { id: 'bambu-studio' }, themeIds: { dark: 'subban-dark', light: 'subban-light' }, appearance: { colorVision: 'redgreen' }, settingsMode: 'expert', autoSlice: true, autoSliceBySize: false, firstRun: { version: 4, printerId: 'bay-1' } })
    // Once through, it does not come back.
    await page.reload()
    await expect(page.locator('.fr')).toHaveCount(0)

    // A profile that finished the version 2 onboarding goes through setup again for the settings mode question.
    await page.evaluate(() => localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', printerId: 'bay-1', settingsMode: 'simple', firstRun: { completedAt: '2026-10-07T00:00:00.000Z', step: 'done', look: { id: 'slicerx' }, printerId: 'bay-1', version: 2 } })))
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Pick a theme' })).toBeVisible()
    await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
    await page.locator('.fr-foot').getByRole('button', { name: 'Next' }).click()
    await expect(page.getByRole('heading', { name: 'Which slicer do you use now?' })).toBeVisible()
    await expect(page.getByTestId('setup-mode-simple')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('setup-mode-advanced').click()
    await page.getByRole('button', { name: 'Skip, use defaults' }).click()
    await expect(page.locator('.fr')).toHaveCount(0)
    await expect(page.getByTestId('slice-mode-chip')).toHaveText('Advanced')
    await page.reload()
    await expect(page.locator('.fr')).toHaveCount(0)
  })

  cold('the CAD-only studio: theme, then mimir, then the plate on Model', async ({ page }) => {
    await cadOnlyStudio(page, false)
  })
})
