// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The cold start waits load the page again when the computer's network changes under it (fixtures.ts, untilReady):
// Chrome drops every request in flight then, loopback ones too, and a start that loses its script chunks never comes
// up. A Wi-Fi roam on the GPU runner did that to four pages at once in a merge queue run. Here the first load loses
// every chunk the app loads after its entry, the way that roam did, and the start still reaches the plate.
import { expect, plateReady, test } from './fixtures'

const A1_MINI = { id: 'e2e-a1-mini', name: 'Desk A1 mini', profileId: 'bambu-a1-mini', vendor: 'Bambu Lab', model: 'A1 mini', nozzleCount: 1 }

test('a cold start whose script chunks the network dropped loads again and reaches the plate', async ({ page }) => {
  // A profile past first-run setup, with a printer, as overlays.spec.ts starts.
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
