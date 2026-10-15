// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Renders the look lab (look.html) for every scene, look, studio and tab, one PNG each, at dpr 2.
// Usage: PW_FROM=<path to packages/ui/viewport/package.json> node look-shots.mjs <base url> <out dir> [gl] [filter]
// gl: metal, vulkan, gl or swiftshader (default swiftshader). filter: a substring the shot name must contain.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(process.env.PW_FROM ?? import.meta.url)
const { chromium } = require('playwright-core')

const base = process.argv[2] ?? 'http://127.0.0.1:5191/look.html'
const out = process.argv[3] ?? 'look-shots'
const gl = process.argv[4] ?? 'swiftshader'
const filter = process.argv[5] ?? ''
mkdirSync(out, { recursive: true })

const args = { swiftshader: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], metal: ['--use-angle=metal'], vulkan: ['--use-angle=vulkan', '--enable-features=Vulkan'], gl: ['--use-angle=gl'] }[gl]
const browser = await chromium.launch({ headless: true, args: [...args, '--ignore-gpu-blocklist', '--enable-gpu'] })
const ctx = await browser.newContext({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 2 })

const scenes = (process.env.SCENES ?? 'organic,mech,dark').split(',')
const looks = (process.env.LOOKS ?? 'current,A,B,C,D').split(',')
const studios = (process.env.STUDIOS ?? 'dark,light').split(',')
const tabs = (process.env.TABS ?? 'slice,model').split(',')
// PATCHES: optional JSON {tag: patch} of tuning variants; each shot is rendered once per tag
const patches = Object.entries(JSON.parse(process.env.PATCHES ?? '{"":{}}'))
// warm-up: the first page in a fresh browser compiles every program and can frame the plate late; its shot is thrown away
{
  const page = await ctx.newPage()
  await page.goto(`${base}?scene=organic&look=current&studio=dark&tab=slice`)
  await page.waitForFunction(() => window.__lookReady === true, null, { timeout: 120000 })
  await page.close()
}
const times = []
for (const scene of scenes)
  for (const studio of studios)
    for (const tab of tabs)
      for (const look of looks)
       for (const [tag, patch] of patches) {
        const name = `${scene}-${studio}-${tab}-${look}${tag ? '-' + tag : ''}`
        if (filter && !name.includes(filter)) continue
        const page = await ctx.newPage()
        const errors = []
        page.on('pageerror', (e) => errors.push(String(e)))
        page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)))
        const t0 = Date.now()
        await page.goto(`${base}?scene=${scene}&look=${look}&studio=${studio}&tab=${tab}&p=${encodeURIComponent(JSON.stringify(patch))}`)
        await page.waitForFunction(() => window.__lookReady === true, null, { timeout: 120000 })
        const info = await page.evaluate(() => window.__lookInfo)
        await page.screenshot({ path: `${out}/${name}.png` })
        const ms = Date.now() - t0
        times.push({ name, ms, info, errors })
        console.log(JSON.stringify({ name, ms, ...info, errors: errors.length ? errors : undefined }))
        await page.close()
      }
writeFileSync(`${out}/times.json`, JSON.stringify(times, null, 1))
await browser.close()
