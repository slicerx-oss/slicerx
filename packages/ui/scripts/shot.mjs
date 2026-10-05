// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Headless full-page screenshots of a running app at desktop and phone widths, for design review.
// Usage: node packages/ui/scripts/shot.mjs <url> <out-dir> <name> [--widths 1440,390] [--wait 1500]
//        [--click "selector"] [--hover "selector"] [--key "Meta+k"] [--reduced-motion] [--scroll [max]]
// Writes <out-dir>/<name>-<width>.jpg (full page) and prints console errors and the horizontal overflow
// at each width. With --scroll it instead walks the page one viewport at a time (for pages that reveal
// on scroll) and writes <name>-<width>-<n>.jpg per screen, plus the headings it passed.
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const [url, outDir, name] = args
if (!url || !outDir || !name) {
  console.error('usage: shot.mjs <url> <out-dir> <name> [--widths 1440,390] [--wait ms] [--click sel] [--hover sel] [--key combo] [--reduced-motion]')
  process.exit(2)
}
const opt = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const widths = opt('--widths', '1440,390').split(',').map(Number)
const wait = Number(opt('--wait', '1500'))
const click = opt('--click')
const hover = opt('--hover')
const key = opt('--key')
const reducedMotion = args.includes('--reduced-motion')
const scroll = args.includes('--scroll')
const maxScreens = Number(opt('--scroll', '16')) || 16

mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const width of widths) {
    const height = width < 600 ? 844 : 900
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    })
    const page = await context.newPage()
    const errors = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(String(e)))
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
    if (click) await page.click(click)
    if (hover) await page.hover(hover)
    if (key) await page.keyboard.press(key)
    await page.waitForTimeout(wait)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (scroll) {
      const total = await page.evaluate(() => document.documentElement.scrollHeight)
      const screens = Math.min(maxScreens, Math.ceil(total / height))
      console.log(`${name}-${width}: ${total}px tall, ${screens} screens, overflow=${overflow}px, errors=${errors.length}`)
      for (let i = 0; i < screens; i++) {
        await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), i * height)
        await page.waitForTimeout(Math.max(600, wait / 2))
        const heads = await page.evaluate(() =>
          Array.from(document.querySelectorAll('h1, h2'))
            .filter((h) => {
              const r = h.getBoundingClientRect()
              return r.bottom > 0 && r.top < innerHeight
            })
            .map((h) => h.textContent?.trim().slice(0, 80)),
        )
        const file = resolve(outDir, `${name}-${width}-${String(i + 1).padStart(2, '0')}.jpg`)
        await page.screenshot({ path: file, type: 'jpeg', quality: 85 })
        console.log(`  ${String(i + 1).padStart(2, '0')} ${heads.join(' | ')}`)
      }
    } else {
      const file = resolve(outDir, `${name}-${width}.jpg`)
      await page.screenshot({ path: file, fullPage: true, type: 'jpeg', quality: 88 })
      console.log(`${file}  overflow=${overflow}px  errors=${errors.length}`)
    }
    for (const e of errors.slice(0, 5)) console.log('  ' + e.slice(0, 200))
    await context.close()
  }
} finally {
  await browser.close()
}
