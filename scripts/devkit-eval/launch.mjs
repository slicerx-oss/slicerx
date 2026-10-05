#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opens an edition's built browser app headless and prints what it shows, as JSON, for score.mjs:
//   node scripts/devkit-eval/launch.mjs <clone>
// The clone's apps/web/dist must be built. Serves it with vite preview and reads it with Playwright's Chromium.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const clone = resolve(process.argv[2] ?? '.')
const web = join(clone, 'apps', 'web')
const { chromium } = createRequire(join(web, 'package.json'))('@playwright/test')

const port = await new Promise((done) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => done(p))
  })
})
const preview = spawn('pnpm', ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: web, stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
const out = { ok: false }
let browser
try {
  const url = `http://127.0.0.1:${port}/studio/`
  for (let i = 0; i < 60; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) break
    await new Promise((r) => setTimeout(r, 500))
  }
  browser = await chromium.launch()
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  Object.assign(out, await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement)
    return {
      title: document.title,
      text: document.body.innerText,
      accent: css.getPropertyValue('--purple').trim(),
      font: getComputedStyle(document.body).fontFamily,
      fontsLoaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')),
    }
  }))
  out.errors = errors
  out.ok = true
} catch (e) {
  out.error = String(e)
} finally {
  await browser?.close()
  // the preview and the vite process under it, by the group this script started
  try {
    // windows has no process groups: end the tree under the shell by its pid
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(preview.pid), '/t', '/f'])
    else process.kill(-preview.pid)
  } catch {}
}
process.stdout.write(`${JSON.stringify(out)}\n`)
