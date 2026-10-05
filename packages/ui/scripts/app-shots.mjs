// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Screenshots of every workspace of the running app plus the command palette, at desktop and
// phone widths. Usage: node packages/ui/scripts/app-shots.mjs <url> <out-dir> [--widths 1440,390]
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const [url, outDir] = process.argv.slice(2)
if (!url || !outDir) {
  console.error('usage: app-shots.mjs <url> <out-dir> [--widths 1440,390]')
  process.exit(2)
}
const wi = process.argv.indexOf('--widths')
const widths = (wi > 0 ? process.argv[wi + 1] : '1440,390').split(',').map(Number)
const tabs = ['Prepare', 'Preview', 'Feed', 'Library', 'Printers', 'mimir']
mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const width of widths) {
    const height = width < 600 ? 844 : 900
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: 'dark' })
    const page = await context.newPage()
    const errors = []
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
    await page.waitForTimeout(2500)
    for (const tab of tabs) {
      const sel = `.sx-tab[aria-label="${tab}"]`
      const found = await page.$(sel)
      if (!found) {
        console.log(`${width} ${tab}: no tab`)
        continue
      }
      await found.click()
      await page.waitForTimeout(1800)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      const words = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a')).filter((b) => b.getClientRects().length)
        const long = btns.filter((b) => (b.textContent || '').trim().split(/\s+/).length > 3).length
        const iconless = btns.filter((b) => !b.querySelector('svg') && (b.textContent || '').trim().length > 0).length
        return { buttons: btns.length, long, iconless }
      })
      const file = resolve(outDir, `${tab.toLowerCase()}-${width}.jpg`)
      await page.screenshot({ path: file, type: 'jpeg', quality: 88 })
      console.log(`${width} ${tab}: overflow=${overflow}px buttons=${words.buttons} long=${words.long} iconless=${words.iconless} errors=${errors.length}`)
    }
    await page.click('.sx-tab[aria-label="Prepare"]').catch(() => undefined)
    await page.waitForTimeout(600)
    await page.keyboard.press('Meta+k')
    await page.waitForTimeout(800)
    const open = await page.$('.sx-palette')
    if (open) {
      await page.keyboard.type('sl')
      await page.waitForTimeout(500)
      const n = await page.evaluate(() => document.querySelectorAll('.sx-palette-item').length)
      await page.screenshot({ path: resolve(outDir, `palette-${width}.jpg`), type: 'jpeg', quality: 88 })
      console.log(`${width} palette: ${n} rows for "sl"`)
      await page.keyboard.press('Escape')
    } else console.log(`${width} palette: did not open on Meta+k`)
    for (const e of errors.slice(0, 6)) console.log('  error: ' + e.slice(0, 200))
    await context.close()
  }
} finally {
  await browser.close()
}
