// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Frame time bench for the web app 3D view (a built app served by vite preview). Needs localStorage slicerx.probe.
// Usage: PW_FROM=<path to packages/ui/viewport/package.json> node frame-bench.mjs <url> <chromium|webkit|swiftshader> [dpr]
import { createRequire } from 'node:module'
const require = createRequire(process.env.PW_FROM ?? import.meta.url)
const { chromium, webkit } = require('playwright-core')

const url = process.argv[2] ?? 'http://127.0.0.1:4417/studio/'
const kind = process.argv[3] ?? 'chromium'
const dpr = Number(process.argv[4] ?? 2)
const SECONDS = Number(process.env.SECS ?? 3)

const browser =
  kind === 'webkit'
    ? await webkit.launch({ headless: true })
    : await chromium.launch({
        headless: true,
        channel: 'chromium',
        args: kind === 'swiftshader' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-vsync=false'],
      })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr })
await ctx.addInitScript(() => {
  sessionStorage.setItem('sx-no-auto-slice', '1')
  if (sessionStorage.getItem('vp4')) return
  sessionStorage.setItem('vp4', '1')
  localStorage.setItem('slicerx.debug', '1')
  localStorage.setItem('slicerx.probe', '1')
  localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced' }))
})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`.slice(0, 300))
})
await page.goto(url)
await page.locator('.obj-name', { hasText: 'Layered X' }).waitFor({ timeout: 60000 })
await page.waitForFunction(() => window.__vp && window.__vp.probeStats && window.__vp.probeStats() !== null, null, { timeout: 30000 })
await page.waitForTimeout(2500)
const info = await page.evaluate(() => {
  const s = window.__vp.stats()
  return { gpu: s.gpu, pixelRatio: s.pixelRatio, width: s.width, height: s.height, quality: s.quality }
})
console.log(JSON.stringify({ kind, dpr, ...info }))

const canvas = await page.locator('.vp-canvas').first().boundingBox()

async function measure(name, act) {
  await page.waitForTimeout(800)
  await page.evaluate(() => window.__vp.resetProbe())
  await act()
  await page.waitForTimeout(50)
  const s = await page.evaluate(() => ({ ...window.__vp.probeStats(), motionScale: window.__vp.stats().motionScale, aoOn: window.__vp.stats().aoOn }))
  const r = (x) => (x == null ? null : Math.round(x * 100) / 100)
  const row = {
    scene: name,
    pageP50: r(s.pageMs.p50),
    pageP95: r(s.pageMs.p95),
    pageMax: r(s.pageMs.max),
    pageFrames: s.pageFrames,
    renders: s.renders,
    cpuP50: r(s.cpuMs.p50),
    cpuP95: r(s.cpuMs.p95),
    gpuP50: s.gpuMs ? r(s.gpuMs.p50) : null,
    gpuP95: s.gpuMs ? r(s.gpuMs.p95) : null,
    gpuN: s.gpuMs ? s.gpuMs.n : 0,
    calls: s.drawCalls,
    tris: s.triangles,
    textures: s.textures,
    geometries: s.geometries,
    programs: s.programs,
    motionScale: s.motionScale,
    aoOn: s.aoOn,
  }
  // One render per page frame at most: more means a second render loop is running.
  if (s.renders > s.pageFrames + 2) row.error = `${s.renders} renders in ${s.pageFrames} page frames`
  console.log(JSON.stringify(row))
  return row
}

const idle = () => page.waitForTimeout(SECONDS * 1000)

async function circle(cx, cy, rad, opts = {}) {
  const n = Math.round(SECONDS * 60)
  await page.mouse.move(cx + rad, cy)
  if (opts.click !== false) await page.mouse.down()
  for (let i = 1; i <= n; i++) {
    const a = (i / n) * Math.PI * 2 * (SECONDS / 1.5)
    await page.mouse.move(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad * 0.5)
    await page.waitForTimeout(12)
  }
  if (opts.click !== false) await page.mouse.up()
}

/** A screen point over the model, found with the viewport's own picker. */
async function modelPoint() {
  return page.evaluate(
    ({ x, y, w, h }) => {
      const vp = window.__vp
      let best = null
      for (let j = 0.3; j <= 0.8 && !best; j += 0.025)
        for (let i = 0.3; i <= 0.7; i += 0.025) {
          const p = { clientX: x + w * i, clientY: y + h * j }
          if (vp.pickFn(p)) {
            best = p
            break
          }
        }
      return best
    },
    { x: canvas.x, y: canvas.y, w: canvas.width, h: canvas.height },
  )
}

const rows = []
rows.push(await measure('prepare idle', idle))
// Orbit from empty space near the top left of the view.
rows.push(await measure('prepare orbit', () => circle(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.22, 60)))
await page.waitForTimeout(800)
const mp = await modelPoint()
if (mp) {
  await page.mouse.click(mp.clientX, mp.clientY)
  await page.waitForTimeout(500)
  rows.push(
    await measure('prepare drag', async () => {
      await page.mouse.move(mp.clientX, mp.clientY)
      await page.mouse.down()
      const n = Math.round(SECONDS * 60)
      for (let i = 1; i <= n; i++) {
        const a = (i / n) * Math.PI * 4
        await page.mouse.move(mp.clientX + Math.sin(a) * 50, mp.clientY + (1 - Math.cos(a)) * 15)
        await page.waitForTimeout(12)
      }
      await page.mouse.up()
    }),
  )
  rows.push(await measure('prepare idle, selected', idle))

  /** A drag from a screen point: a back and forth arc, one move per page frame. */
  const dragFrom = async (x, y) => {
    await page.mouse.move(x, y)
    await page.mouse.down()
    const n = Math.round(SECONDS * 60)
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * Math.PI * 4
      await page.mouse.move(x + Math.sin(a) * 60, y + (1 - Math.cos(a)) * 20)
      await page.waitForTimeout(12)
    }
    await page.mouse.up()
  }
  // Rotate tool: a ring drag, or in a build without rings the old drag on the model.
  await page.evaluate(() => window.__vp.setTool('rotate'))
  await page.waitForTimeout(300)
  const rings = await page.evaluate(() => (window.__vp.rotateHandles ? window.__vp.rotateHandles() : null))
  rows.push(await measure('prepare orbit, rotate tool', () => circle(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.22, 60)))
  await page.waitForTimeout(500)
  if (rings?.z) rows.push(await measure('prepare rotate ring drag', () => dragFrom(canvas.x + rings.z[0], canvas.y + rings.z[1])))
  else rows.push(await measure('prepare rotate drag, no rings', () => dragFrom(mp.clientX, mp.clientY)))
  await page.evaluate(() => window.__vp.setTool('move'))
  // Cut plane through the middle of the selected model, then a drag of its grabber.
  const cut = await page.evaluate((p) => {
    const vp = window.__vp
    if (!vp.setCutPlane) return null
    const hit = vp.pickFn(p)
    if (!hit) return null
    const b = vp.bedBox(hit.entry)
    vp.setCutPlane({ objectId: hit.entry.id, point: [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2], normal: [0, 0, 1] })
    return true
  }, mp)
  if (cut) {
    await page.waitForTimeout(500)
    rows.push(await measure('prepare orbit, cut plane', () => circle(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.22, 60)))
    await page.waitForTimeout(500)
    const h = await page.evaluate(() => window.__vp.cutHandles())
    if (h) rows.push(await measure('prepare cut grabber drag', () => dragFrom(canvas.x + h.grabber[0], canvas.y + h.grabber[1])))
    const h2 = await page.evaluate(() => window.__vp.cutHandles())
    if (h2) rows.push(await measure('prepare cut tilt drag', () => dragFrom(canvas.x + h2.u[0], canvas.y + h2.u[1])))
    await page.evaluate(() => window.__vp.setCutPlane(null))
  }
  // Push and pull, through the app's tool: a drag on the face under the model point streams the
  // distance while the view stretches the preview prism; the boolean runs once after release.
  const openTool = async (name) => {
    try {
      await page.getByRole('button', { name: 'Tools', exact: true }).click({ timeout: 3000 })
      await page.getByRole('menuitem', { name, exact: true }).click({ timeout: 3000 })
      await page.waitForTimeout(600)
      return true
    } catch {
      await page.keyboard.press('Escape')
      return false
    }
  }
  if (await openTool('Push and pull')) {
    rows.push(await measure('prepare orbit, push tool', () => circle(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.22, 60)))
    rows.push(
      await measure('prepare push drag', async () => {
        await page.mouse.move(mp.clientX, mp.clientY)
        await page.mouse.down()
        const n = Math.round(SECONDS * 60)
        for (let i = 1; i <= n; i++) {
          await page.mouse.move(mp.clientX, mp.clientY - Math.sin((i / n) * Math.PI) * 40)
          await page.waitForTimeout(12)
        }
        // Back to where it started, so the release asks for no change.
        await page.mouse.move(mp.clientX, mp.clientY)
        await page.mouse.up()
      }),
    )
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Done', exact: true }).click({ timeout: 3000 }).catch(() => undefined)
  } else console.log(JSON.stringify({ scene: 'prepare push drag', error: 'no Push and pull tool' }))
  // Sketch mode on the bed: a line started in front of the model, then the cursor circling with the rubber band.
  if (await openTool('Sketch')) {
    const bx = canvas.x + canvas.width * 0.5
    const by = canvas.y + canvas.height * 0.82
    await page.mouse.click(bx, by)
    await page.waitForTimeout(800)
    await page.mouse.click(bx - 40, by)
    await page.waitForTimeout(300)
    rows.push(await measure('prepare sketch drawing', () => circle(bx, by, 70, { click: false })))
    await page.keyboard.press('Escape')
    rows.push(await measure('prepare orbit, sketch', () => circle(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.22, 60)))
    await page.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: 3000 }).catch(() => undefined)
  } else console.log(JSON.stringify({ scene: 'prepare sketch drawing', error: 'no Sketch tool' }))
} else console.log(JSON.stringify({ scene: 'prepare drag', error: 'no model under the probe grid' }))

// Preview of the sliced two color plate.
try {
  await page.getByRole('button', { name: 'Slice plate' }).click({ timeout: 10000 })
} catch {
  // Say what the page offers instead, then stop: the Preview scenes need a slice.
  const names = await page.getByRole('button').evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim()).filter(Boolean))
  console.log(JSON.stringify({ error: 'no Slice plate button', buttons: names.slice(0, 60), errors: errors.slice(0, 20) }))
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT })
  await browser.close()
  process.exit(1)
}
await page.getByRole('group', { name: 'Layers and moves' }).waitFor({ timeout: 90000 })
await page.waitForTimeout(2000)
const seg = await page.evaluate(() => window.__vp.stats().segments)
console.log(JSON.stringify({ segments: seg }))
rows.push(await measure('preview idle', idle))
rows.push(await measure('preview orbit', () => circle(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.22, 60)))
await page.waitForTimeout(800)
await page.locator('#pv-layer').focus()
await page.keyboard.press('End')
rows.push(
  await measure('preview scrub', async () => {
    const n = Math.round(SECONDS * 60)
    for (let i = 0; i < n; i++) {
      await page.keyboard.press(i < n / 2 ? 'ArrowLeft' : 'ArrowRight')
      await page.waitForTimeout(12)
    }
  }),
)
console.log(JSON.stringify({ errors: errors.slice(0, 20) }))
await browser.close()
