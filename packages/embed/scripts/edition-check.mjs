// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Browser check for edition theming: the embed demo with no edition keeps the SlicerX studio and accent, the same page
// with a lime edition config (fetched at runtime through edition-src) draws the lime studio and accent in dark and
// light, and the kit's exported loops are transparent unless a backdrop is asked for, with --sx-loop-backdrop as the
// host's runtime control over their ground (a setting popover on the default and the lime edition shows it). Saves
// screenshots with --shots.
//
//   node packages/embed/scripts/edition-check.mjs [--shots <dir>] [--port <n>]
//
// Needs Node 24, an installed checkout and Playwright's Chromium (apps/web). WebGL runs in SwiftShader.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const embed = resolve(here, '..')
const args = process.argv.slice(2)
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const shots = opt('--shots') ? resolve(opt('--shots')) : null
const port = Number(opt('--port') ?? 0)
if (shots) mkdirSync(shots, { recursive: true })

const work = mkdtempSync(join(tmpdir(), 'sx-edition-check-'))
const lime = JSON.parse(readFileSync(join(embed, 'demo/public/editions/lime.json'), 'utf8'))
const hexRgb = (h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16))
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const results = []
const step = async (name, fn) => {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`ok   ${name}`)
  } catch (e) {
    results.push({ name, ok: false })
    console.log(`FAIL ${name}\n     ${e instanceof Error ? e.message.split('\n').join('\n     ') : e}`)
  }
}

const { build } = await import(pathToFileURL(createRequire(join(embed, 'package.json')).resolve('vite')).href)
await build({ root: join(embed, 'demo'), logLevel: 'error', build: { outDir: join(work, 'demo'), emptyOutDir: true } })
const { exportAssets } = await import(pathToFileURL(join(repo, 'scripts/export-kit-assets.mjs')).href)
await exportAssets(join(work, 'kit'))
await exportAssets(join(work, 'kit-backdrop'), { backdrop: true, edition: lime })
// A host page that sets its own viewport color and inlines one loop over it, from each export.
const loopPage = (dir, bg) => `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/${dir}/tokens.css"><style>body{margin:0;background:#ffffff}.host{display:inline-block;padding:24px;background:${bg}}</style><div class="host" data-sx-theme="dark"><div id="loop"></div></div><script type="module">document.getElementById('loop').innerHTML = await (await fetch('/${dir}/loops/dark/push.svg')).text(); document.body.dataset.ready = 'true'</script>`
writeFileSync(join(work, 'loop-clear.html'), loopPage('kit', '#1a1d23'))
writeFileSync(join(work, 'loop-clear-default.html'), loopPage('kit', '#2f3241'))
writeFileSync(join(work, 'loop-backdrop.html'), loopPage('kit-backdrop', '#ffffff'))
await exportAssets(join(work, 'kit-lime'), { edition: lime })
// A setting popover as a host draws it: a title, one line, and the loop under it. `ground` is the host's
// --sx-loop-backdrop, when it sets one.
const popoverPage = (dir, surface, fg, ground) => `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/${dir}/tokens.css"><style>body{margin:0;background:#ffffff;font:13px system-ui,sans-serif}.host{display:inline-block;padding:24px;background:#ffffff}.pop{width:320px;box-sizing:border-box;padding:12px;border-radius:8px;background:${surface};color:${fg};box-shadow:0 8px 24px rgb(0 0 0 / 35%)}.pop h3{margin:0 0 4px;font-size:13px}.pop p{margin:0 0 8px;opacity:.75;line-height:1.4}#loop svg{display:block;width:100%;height:auto;border-radius:6px}${ground ? `.pop{--sx-loop-backdrop:${ground}}` : ''}</style><div class="host"><div class="pop" data-sx-theme="dark"><h3>Slow down on overhangs</h3><p>A wall slows down in steps as it hangs further out, so each part cools before the next.</p><div id="loop"></div></div></div><script type="module">document.getElementById('loop').innerHTML = await (await fetch('/${dir}/loops/dark/adv-overhang-speed.svg')).text(); document.body.dataset.ready = 'true'</script>`
writeFileSync(join(work, 'popover-default.html'), popoverPage('kit', '#282a36', '#f8f8f2'))
writeFileSync(join(work, 'popover-lime.html'), popoverPage('kit-lime', '#1a1d23', '#f5f5f0'))
writeFileSync(join(work, 'popover-lime-ground.html'), popoverPage('kit-lime', '#1a1d23', '#f5f5f0', 'linear-gradient(180deg, #2a2e37, #0a0c10)'))
// the host removes a baked-in default backdrop with the same property
writeFileSync(join(work, 'loop-backdrop-removed.html'), loopPage('kit-backdrop', '#1a1d23').replace('</style>', '.host{--sx-loop-backdrop:transparent}</style>'))

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' }
const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  const file = join(work, path.startsWith('/kit') || path.startsWith('/loop') || path.startsWith('/popover') ? '' : 'demo', decodeURIComponent(path.endsWith('/') ? `${path}index.html` : path))
  if (!file.startsWith(work) || !existsSync(file)) return void res.writeHead(404).end()
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file))
})
await new Promise((r) => server.listen(port, '127.0.0.1', () => r(undefined)))
const base = `http://127.0.0.1:${server.address().port}`

const pw = await import(pathToFileURL(createRequire(join(repo, 'apps/web/package.json')).resolve('@playwright/test')).href)
const chromium = pw.chromium ?? pw.default.chromium
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })

/** One pixel of a PNG screenshot, decoded in the page. */
async function pixel(page, png, x, y) {
  return page.evaluate(async ({ b64, x, y }) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = new OffscreenCanvas(img.width, img.height)
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    return [...g.getImageData(x, y, 1, 1).data.slice(0, 3)]
  }, { b64: png.toString('base64'), x, y })
}

/** Waits until the 3D view has drawn and stopped changing (the plate reveal is about 2 s). */
async function settled(page) {
  const canvas = page.locator('sx-viewport canvas')
  // software WebGL holds the first page for a while as its shaders compile
  await canvas.waitFor({ timeout: 240_000 })
  let last = null
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1500)
    const shot = await canvas.screenshot({ timeout: 60_000 })
    if (last && shot.equals(last)) return shot
    last = shot
  }
  return last
}

async function demo(query, label, width = 1280, height = 900) {
  const page = await browser.newPage({ viewport: { width, height } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${base}/${query}`)
  if (query.includes('edition=')) await page.waitForFunction(() => document.querySelector('sx-viewport')?.edition, null, { timeout: 240_000 })
  const shot = await settled(page)
  const state = await page.evaluate(() => document.querySelector('sx-viewport').activeTheme)
  const accent = await page.evaluate(() => getComputedStyle(document.querySelector('sx-settings-panel').shadowRoot.querySelector('.sx-theme-scope')).getPropertyValue('--accent').trim())
  const corner = await pixel(page, shot, 4, 4)
  // the view's tool bar and its icons, as drawn: background and icon color from the shadow root
  const bar = await page.evaluate(() => {
    const root = document.querySelector('sx-viewport').shadowRoot
    const tools = root.querySelector('.sxe-tools')
    const icon = root.querySelector('.sxe-tool:not([aria-pressed=true])')
    return tools && icon ? { bg: getComputedStyle(tools).backgroundColor, ink: getComputedStyle(icon).color } : null
  })
  if (shots) await page.screenshot({ path: join(shots, `${label}.png`), fullPage: true })
  await page.close()
  assert.deepEqual(errors, [], `${label}: page errors`)
  return { state, accent, corner, bar }
}

/** Relative luminance of a computed CSS color (rgb() or color(srgb ...)), ignoring alpha. */
function luminance(css) {
  const n = css.match(/[\d.]+/g).map(Number)
  const rgb = css.startsWith('color(') ? n.slice(0, 3) : n.slice(0, 3).map((v) => v / 255)
  const lin = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
/** The tool bar follows the scheme, and its idle icons keep 3:1 against it. */
function checkBar(r, scheme) {
  assert.ok(r.bar, 'the tool bar is drawn')
  const bg = luminance(r.bar.bg)
  assert.ok(scheme === 'light' ? bg > 0.7 : bg < 0.1, `${scheme} bar ${r.bar.bg}`)
  assert.ok(contrast(bg, luminance(r.bar.ink)) >= 3, `icons ${r.bar.ink} on ${r.bar.bg}: ${contrast(bg, luminance(r.bar.ink)).toFixed(2)}:1`)
}

let slicerx
await step('SlicerX default: the studio and accent are unchanged', async () => {
  slicerx = await demo('', 'embed-default-dark')
  assert.equal(slicerx.state.scene.bgTop, '#2f3241')
  assert.equal(slicerx.state.scene.bgBottom, '#20222b')
  assert.equal(slicerx.state.accent, '#bd93f9')
  assert.deepEqual(slicerx.state.overrides, { visuals: {}, scene: {} })
  checkBar(slicerx, 'dark')
})
await step('lime edition, dark: the edition config sets the studio, grid and accent at runtime', async () => {
  const r = await demo('?edition=editions/lime.json', 'embed-lime-dark')
  assert.equal(r.state.scene.bgTop, '#1a1d23')
  assert.equal(r.state.scene.bgBottom, '#0a0c10')
  assert.equal(r.state.scene.floorGrid, '#4a5363')
  assert.equal(r.state.accent, '#b8f34a')
  assert.equal(r.accent, '#b8f34a', 'the settings panel takes the edition accent')
  // The drawn backdrop moved by about the configured change: the view grades and vignettes the gradient, so the pixel
  // is compared as a shift from the SlicerX pixel, in the direction from the SlicerX top color to the edition's.
  const want = hexRgb('#1a1d23').map((v, i) => v - hexRgb('#2f3241')[i])
  const got = r.corner.map((v, i) => v - slicerx.corner[i])
  const cos = want.reduce((sum, v, i) => sum + v * got[i], 0) / (Math.hypot(...want) * Math.hypot(...got) || 1)
  checkBar(r, 'dark')
  assert.ok(Math.hypot(...got) > 10 && cos > 0.8, `corner ${r.corner} against SlicerX ${slicerx.corner}: shift ${got}, cosine ${cos.toFixed(2)}`)
})
await step('lime edition, light: the light block applies with the scheme', async () => {
  const r = await demo('?edition=editions/lime.json&theme=light', 'embed-lime-light')
  assert.equal(r.state.scheme, 'light')
  assert.equal(r.state.scene.bgTop, '#f1f4ee')
  assert.equal(r.state.accent, '#456b0b')
  assert.equal(r.accent, '#456b0b')
  checkBar(r, 'light')
})
await step('SlicerX light: the tool bar is light, with readable icons', async () => {
  const r = await demo('?theme=light', 'embed-default-light')
  assert.equal(r.state.scheme, 'light')
  checkBar(r, 'light')
})
await step('lime edition at phone width', async () => {
  const r = await demo('?edition=editions/lime.json', 'embed-lime-dark-phone', 390, 844)
  assert.equal(r.state.accent, '#b8f34a')
})

/** The demo's origin planes view: how many pixels lean to the given hue family (green or purple) over the plane. */
async function planes(query, label) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${base}/${query}`)
  const canvas = page.locator('#planes canvas')
  await canvas.waitFor({ timeout: 240_000 })
  let shot = null
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1500)
    const next = await canvas.screenshot({ timeout: 60_000 })
    if (shot && next.equals(shot)) break
    shot = next
  }
  if (shots) await page.screenshot({ path: join(shots, `${label}.png`), fullPage: true })
  const tally = await page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = new OffscreenCanvas(img.width, img.height)
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, img.width, img.height).data
    let green = 0, purple = 0
    for (let i = 0; i < d.length; i += 4) {
      const [r, gr, b] = [d[i], d[i + 1], d[i + 2]]
      if (gr > r + 25 && gr > b + 25) green++
      if (r > gr + 25 && b > gr + 25) purple++
    }
    return { green, purple }
  }, shot.toString('base64'))
  await page.close()
  assert.deepEqual(errors, [], `${label}: page errors`)
  return tally
}
await step('the origin planes take the edition accent: purple by default, lime with the lime edition', async () => {
  const slicerxPlanes = await planes('?planes', 'planes-default-dark')
  const limePlanes = await planes('?planes&edition=editions/lime.json', 'planes-lime-dark')
  assert.ok(slicerxPlanes.purple > 500 && slicerxPlanes.green < 50, `default: ${JSON.stringify(slicerxPlanes)}`)
  assert.ok(limePlanes.green > 500 && limePlanes.purple < 50, `lime: ${JSON.stringify(limePlanes)}`)
})

async function loop(file, label) {
  const page = await browser.newPage({ viewport: { width: 420, height: 360 } })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${base}/${file}`)
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  const svg = page.locator('#loop svg')
  const shot = await svg.screenshot()
  if (shots) await page.locator('.host').screenshot({ path: join(shots, `${label}.png`) })
  const corner = await pixel(page, shot, 8, 8)
  const backdrop = await svg.evaluate((el) => getComputedStyle(el).backgroundImage !== 'none' ? 1 : 0)
  await page.close()
  return { corner, backdrop }
}
await step('kit loops are transparent by default: the host viewport color shows through', async () => {
  for (const [file, bg] of [['loop-clear.html', '#1a1d23'], ['loop-clear-default.html', '#2f3241']]) {
    const r = await loop(file, file.replace('.html', ''))
    assert.equal(r.backdrop, 0, `${file}: a backdrop gradient`)
    assert.ok(dist(r.corner, hexRgb(bg)) <= 2, `${file}: corner ${r.corner}, host ${bg}`)
  }
})
await step('kit loops with --backdrop and the edition draw the edition studio', async () => {
  const r = await loop('loop-backdrop.html', 'loop-backdrop-lime')
  assert.equal(r.backdrop, 1)
  assert.ok(dist(r.corner, hexRgb('#1a1d23')) <= 3, `corner ${r.corner}`)
})
await step('the host removes a default backdrop at runtime with --sx-loop-backdrop', async () => {
  const r = await loop('loop-backdrop-removed.html', 'loop-backdrop-removed')
  assert.equal(r.backdrop, 0)
  assert.ok(dist(r.corner, hexRgb('#1a1d23')) <= 2, `corner ${r.corner}`)
})
await step('a setting popover: the loop sits on the popover in the default and lime editions', async () => {
  for (const [file, surface] of [['popover-default.html', '#282a36'], ['popover-lime.html', '#1a1d23']]) {
    const r = await loop(file, file.replace('.html', ''))
    assert.equal(r.backdrop, 0, file)
    assert.ok(dist(r.corner, hexRgb(surface)) <= 2, `${file}: corner ${r.corner}, popover ${surface}`)
  }
})
await step('a setting popover: the host sets its own loop ground with --sx-loop-backdrop', async () => {
  const r = await loop('popover-lime-ground.html', 'popover-lime-ground')
  assert.equal(r.backdrop, 1)
  assert.ok(dist(r.corner, hexRgb('#2a2e37')) <= 4, `corner ${r.corner}`)
})

await browser.close()
server.close()
rmSync(work, { recursive: true, force: true })
const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed} of ${results.length} checks passed${shots ? `; screenshots in ${shots}` : ''}`)
process.exit(failed ? 1 : 0)
