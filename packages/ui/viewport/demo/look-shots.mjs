// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Drives the look lab (look.html) through a list of jobs: each opens the page with a query, waits for the still frame,
// optionally saves a PNG and evaluates measuring calls on window.__lab (look.ts), printing one JSON line per job.
// Usage: PW_FROM=<path to packages/ui/viewport/package.json> node look-shots.mjs <base url> <out dir> <jobs.json> [gl]
// jobs.json: [{ "name": "...", "q": "scene=block&shade=new&studio=precision&tab=model&cam=close", "shot": true,
//               "eval": ["__lab.stats()", "__lab.perf()"], "mouse": [x, y] (optional pointer position, CSS px) }]
// gl: metal, vulkan, gl or swiftshader (default metal).
import { mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(process.env.PW_FROM ?? import.meta.url)
const { chromium } = require('playwright-core')

const base = process.argv[2] ?? 'http://127.0.0.1:5291/look.html'
const out = process.argv[3] ?? 'look-shots'
const jobs = JSON.parse(readFileSync(process.argv[4], 'utf8'))
const gl = process.argv[5] ?? 'metal'
mkdirSync(out, { recursive: true })

const args = { swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], metal: ['--use-angle=metal'], vulkan: ['--use-angle=vulkan', '--enable-features=Vulkan'], gl: ['--use-angle=gl'] }[gl]
const browser = await chromium.launch({ headless: true, args: [...args, '--ignore-gpu-blocklist', '--enable-gpu'] })
const ctx = await browser.newContext({ viewport: { width: Number(process.env.VW ?? 960), height: Number(process.env.VH ?? 600) }, deviceScaleFactor: 2 })
// warm-up: the first page in a fresh browser compiles every program; its result is thrown away
if (!process.env.NOWARM) {
  const page = await ctx.newPage()
  await page.goto(`${base}?scene=block&shade=new&studio=precision&tab=model`)
  await page.waitForFunction(() => window.__lookReady === true, null, { timeout: 120000 })
  await page.close()
}
for (const job of jobs) {
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)))
  const t0 = Date.now()
  let res = {}
  try {
    await page.goto(`${base}?${job.q}`)
    await page.waitForFunction(() => window.__lookReady === true, null, { timeout: 120000 })
    if (job.mouse) {
      // a pointer over the canvas (CSS px), then two frames so a hover highlight is drawn
      await page.mouse.move(job.mouse[0], job.mouse[1])
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300)))))
    }
    if (job.shot !== false) await page.screenshot({ path: `${out}/${job.name}.png` })
    for (const e of job.eval ?? []) res[e] = await page.evaluate(`(async () => ${e})()`)
    if (job.frames) {
      // a turn drawn by the viewport's own loop: the camera steps each animation frame, a PNG per step
      const { n, deg } = job.frames
      mkdirSync(`${out}/${job.name}`, { recursive: true })
      for (let i = 0; i < n; i++) {
        await page.evaluate(([i, n, deg]) => new Promise((r) => {
          const c = window.__lab.cam
          window.__lab.vp.setCamera({ ...c, azimuthDeg: c.azimuthDeg + (i / n) * deg }, { animate: false })
          requestAnimationFrame(() => requestAnimationFrame(() => r(null)))
        }), [i, n, deg])
        await page.screenshot({ path: `${out}/${job.name}/f${String(i).padStart(4, '0')}.png` })
      }
    }
  } catch (e) {
    errors.push(String(e).slice(0, 300))
  }
  const line = JSON.stringify({ name: job.name, ms: Date.now() - t0, res, errors: errors.length ? errors : undefined })
  console.log(line)
  appendFileSync(`${out}/results.jsonl`, line + '\n')
  await page.close()
}
await browser.close()
