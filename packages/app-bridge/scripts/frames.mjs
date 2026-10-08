// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Frame capture of the running desktop app across an edit, an undo in Preview and a model opened, each followed by the
// background slice, then a check of every frame. A frame where the 3D view went blank (one flat color) or shows a
// picture like neither the one before the step nor the one after it is a flicker. The bridge drives the app. On
// Windows every composited frame comes from WebView2's DevTools screencast (--cdp-port, the app started with the
// debugging port), since a one-frame blank slips between screenshots; elsewhere the bridge's screenshots are taken
// back to back. Starts a bridge build with a fresh web profile and stops it by its pid.
//   node packages/app-bridge/scripts/frames.mjs --app <bridge binary> --file <model> [--out <dir>] [--cdp-port <port>]
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { inflateSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { createAppClient } from '../src/client.ts'

const { values } = parseArgs({ options: { app: { type: 'string' }, file: { type: 'string' }, out: { type: 'string' }, 'cdp-port': { type: 'string' } }, strict: true })
const cdpPort = values['cdp-port'] ? Number(values['cdp-port']) : null
if (!values.app || !values.file) {
  console.error('usage: node frames.mjs --app <bridge binary> --file <model> [--out <dir>]')
  process.exit(2)
}
const out = resolve(values.out ?? join(tmpdir(), `sx-frames-${Date.now()}`))
mkdirSync(out, { recursive: true })
const tokenFile = join(out, 'bridge.json')
rmSync(tokenFile, { force: true })
const env = { ...process.env, SX_AGENT_BRIDGE_PORT: '0', SX_AGENT_BRIDGE_TOKEN_FILE: tokenFile }
if (process.platform === 'win32') env.WEBVIEW2_USER_DATA_FOLDER = join(out, 'webview2')
if (cdpPort) env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${cdpPort}`
const child = spawn(values.app, [], { env, stdio: ['ignore', 'ignore', 'pipe'] })
let stderr = ''
let exited = false
child.stderr.on('data', (d) => (stderr += d))
child.on('exit', () => (exited = true))
console.log(`started ${values.app} as pid ${child.pid}; frames in ${out}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const app = createAppClient(tokenFile)
const call = (tool, args = {}) => app.call(tool, args)

// ---------- PNG to a grid of gray levels ----------

const GW = 96
const GH = 60

/** Decodes an 8-bit RGB or RGBA PNG (what the web views write) into a GW by GH grid of gray levels. */
function grid(png) {
  let o = 8
  let w = 0
  let h = 0
  let type = 0
  const idat = []
  while (o < png.length) {
    const len = png.readUInt32BE(o)
    const kind = png.toString('ascii', o + 4, o + 8)
    const body = png.subarray(o + 8, o + 8 + len)
    if (kind === 'IHDR') {
      w = body.readUInt32BE(0)
      h = body.readUInt32BE(4)
      type = body[9]
    } else if (kind === 'IDAT') idat.push(body)
    o += 12 + len
  }
  const bpp = type === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  const px = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0
      const b = y > 0 ? px[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0
      const p = a + b - c
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
      const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? pr : 0
      px[y * stride + x] = (src[x] + pred) & 255
    }
  }
  const g = new Array(GW * GH).fill(0)
  const n = new Array(GW * GH).fill(0)
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = y * stride + x * bpp
      const cell = Math.min(GH - 1, Math.floor((y / h) * GH)) * GW + Math.min(GW - 1, Math.floor((x / w) * GW))
      g[cell] += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
      n[cell]++
    }
  }
  return g.map((v, i) => v / Math.max(1, n[i]))
}

// The 3D view: right of the sidebar, below the top bar, above the status line (fractions of the window).
const VIEW = []
for (let y = Math.floor(GH * 0.12); y < Math.floor(GH * 0.9); y++) for (let x = Math.floor(GW * 0.3); x < Math.floor(GW * 0.97); x++) VIEW.push(y * GW + x)

const spread = (g) => {
  const m = VIEW.reduce((s, c) => s + g[c], 0) / VIEW.length
  return Math.sqrt(VIEW.reduce((s, c) => s + (g[c] - m) ** 2, 0) / VIEW.length)
}
function alike(a, b) {
  const ma = VIEW.reduce((s, c) => s + a[c], 0) / VIEW.length
  const mb = VIEW.reduce((s, c) => s + b[c], 0) / VIEW.length
  let ab = 0
  let aa = 0
  let bb = 0
  for (const c of VIEW) {
    ab += (a[c] - ma) * (b[c] - mb)
    aa += (a[c] - ma) ** 2
    bb += (b[c] - mb) ** 2
  }
  return aa === 0 || bb === 0 ? 0 : ab / Math.sqrt(aa * bb)
}

// ---------- capture ----------

let capturing = false
const frames = []
/** The page over DevTools, when the app runs with a debugging port: every composited frame, not a screenshot now and then. */
let page = null
let cdp = null

async function connectCdp() {
  // Playwright comes with the web app's e2e tests.
  const { chromium } = createRequire(resolve(import.meta.dirname, '../../../apps/web/package.json'))('@playwright/test')
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
  page = browser.contexts()[0].pages()[0]
  cdp = await page.context().newCDPSession(page)
}

async function screencast(dir) {
  const pending = []
  const onFrame = (f) => {
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined)
    pending.push({ t: Math.round((f.metadata.timestamp ?? Date.now() / 1000) * 1000), data: f.data })
  }
  cdp.on('Page.screencastFrame', onFrame)
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 960, maxHeight: 600, everyNthFrame: 1 })
  while (capturing) await sleep(50)
  await cdp.send('Page.stopScreencast')
  cdp.off('Page.screencastFrame', onFrame)
  for (const [i, f] of pending.entries()) {
    const png = Buffer.from(f.data, 'base64')
    writeFileSync(join(dir, `${String(i).padStart(4, '0')}.png`), png)
    frames.push({ t: f.t, done: f.t, g: grid(png) })
  }
}

async function captureLoop(dir) {
  if (cdp) return screencast(dir)
  while (capturing) {
    const t = Date.now()
    try {
      const shot = await call('screenshot')
      const png = Buffer.from(shot.data, 'base64')
      const i = frames.length
      writeFileSync(join(dir, `${String(i).padStart(4, '0')}.png`), png)
      frames.push({ t, done: Date.now(), g: grid(png) })
    } catch (e) {
      console.log(`screenshot failed: ${e.message}`)
      await sleep(50)
    }
  }
}

async function sliced(timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const s = (await call('state')).slicing
    if (s?.status === 'done' && !s.stale) return
    if (s?.status === 'error') throw new Error(`slice failed: ${s.message}`)
    if (Date.now() > end) throw new Error('no slice in time')
    await sleep(200)
  }
}

/** Records one step and the slice after it, then checks its frames. */
async function step(name, act) {
  const dir = join(out, name)
  mkdirSync(dir, { recursive: true })
  frames.length = 0
  capturing = true
  const loop = captureLoop(dir)
  await sleep(600)
  const t0 = Date.now()
  await act()
  // The step lands (a model arriving reframes the view, which is not a flicker); from here only the slice runs.
  const landed = Date.now()
  await sleep(300)
  await sliced()
  await sleep(1500)
  capturing = false
  await loop
  // The screencast sends a frame only when the picture changes: one frame (or none) means nothing on screen moved.
  if (frames.length < 2) {
    console.log(`${name}: ${frames.length} frames, the picture did not change`)
    return true
  }
  // Frames while the step acts (the command bar is open over the view) are left out; the picture before the slice
  // starts is the first frame a second after the step, once Arrange or an opened model has framed the view.
  const acting = (f) => f.t >= t0 && f.t <= landed + 300
  const settled = frames.find((f) => f.t > landed + 1000) ?? frames[0]
  const first = frames[0]
  const last = frames.at(-1)
  const drawn = spread(first.g)
  const rows = []
  const bad = []
  for (const [i, f] of frames.entries()) {
    const s = spread(f.g)
    const like = Math.max(alike(f.g, settled.g), alike(f.g, last.g))
    // A frame much like the finished picture is not blank, however plain: the view after Arrange can be.
    const blank = !acting(f) && s < drawn * 0.3 && alike(f.g, last.g) < 0.95
    const swapped = f.t > landed + 1000 && like < 0.8
    if (blank || swapped) bad.push(`${i}: ${blank ? 'blank' : 'swapped'} at ${f.t - t0} ms (spread ${s.toFixed(1)}, like ${like.toFixed(2)})`)
    rows.push(`${i} ${f.t - t0} ms, took ${f.done - f.t} ms, spread ${s.toFixed(1)}, like start ${alike(f.g, first.g).toFixed(2)} end ${alike(f.g, last.g).toFixed(2)}`)
  }
  const gaps = frames.slice(1).map((f, i) => f.t - frames[i].t)
  const summary = `${name}: ${frames.length} frames over ${last.t - first.t} ms, median gap ${gaps.sort((a, b) => a - b)[gaps.length >> 1]} ms; ${bad.length ? `${bad.length} bad frames` : 'no blank or swapped frames'}`
  writeFileSync(join(dir, 'report.txt'), [summary, ...bad, '', ...rows].join('\n'))
  console.log([summary, ...bad.slice(0, 10)].join('\n'))
  return bad.length === 0
}

/** Runs a command by its title through the command bar (Mod+K), as a person does. */
async function command(title) {
  if (page) {
    await page.keyboard.press('ControlOrMeta+k')
    await page.keyboard.type(title)
    await sleep(300)
    await page.keyboard.press('Enter')
  } else {
    await call('press_key', { key: 'k', ctrl: process.platform !== 'darwin', meta: process.platform === 'darwin' })
    await sleep(300)
    for (const ch of title) await call('press_key', { key: ch })
    await call('press_key', { key: 'Enter' })
  }
  await sleep(300)
}

/** Switches the workspace tab by its label, through the page when connected, else by the tab's test id. */
async function tab(label) {
  if (page) return page.locator('.sx-tab', { hasText: label }).first().click()
  await call('click', { testid: label === 'Preview' ? 'tab-preview' : 'tab-prepare' })
}

let ok = false
try {
  for (let i = 0; i < 240 && !existsSync(tokenFile) && !exited; i++) await sleep(500)
  // The web view needs the desktop session: started from a service or ssh it cannot make a window and the app exits.
  if (!existsSync(tokenFile)) throw new Error(`the app did not start its bridge${exited ? ' and exited' : ''}: ${stderr.slice(-400)}`)
  for (let i = 0; i < 240; i++) {
    const h = await app.health().catch(() => null)
    if (h?.appReady) break
    await sleep(500)
  }
  // First run on the fresh profile: the agreement, then Skip, until the objects list shows.
  for (let i = 0; i < 120; i++) {
    const ids = await call('testids').catch(() => ({}))
    if (ids['objects-list']) break
    if (ids['agreement-check']) {
      await call('click', { testid: 'agreement-check' })
      await call('click', { testid: 'agreement-accept' })
    } else if (ids['setup-skip-all']) await call('click', { testid: 'setup-skip-all' })
    await sleep(500)
  }
  if (cdpPort) await connectCdp()
  await sliced()
  await sleep(1500)
  const edit = await step('edit', async () => {
    // Add an instance of the first object (an edit that changes the print, so the background slice runs), then
    // arrange, so the copy and its skirt are on the bed whatever room the first placement found.
    await call('click', { testid: 'object-select', index: 0 })
    await command('Add an instance')
    await command('Arrange all objects')
  })
  // In Preview: undo the instance, so the toolpaths go stale (drawn dimmed) until the new slice lands.
  await tab('Preview')
  await sleep(2000)
  const preview = await step('preview', () => (page ? page.keyboard.press('ControlOrMeta+z') : call('press_key', { key: 'z', ctrl: process.platform !== 'darwin', meta: process.platform === 'darwin' })))
  await tab('Slice')
  await sleep(1500)
  const load = await step('open', async () => {
    const before = (await call('state')).plate?.objects?.map((o) => o.id).join() ?? ''
    await call('open_file', { path: resolve(values.file) })
    // Opening asks about the unsaved edit first; the plate counts as landed once the file's objects are on it.
    for (let i = 0; i < 600; i++) {
      const s = await call('state')
      // Opening asks whether to save the edit first; the dialog may still be on its way in, so a miss is tried again.
      if (s.unsavedPrompt) await call('click', { testid: 'unsaved-discard' }).catch(() => undefined)
      else if ((s.plate?.objects?.map((o) => o.id).join() ?? '') !== before && !s.plate?.loading) return
      await sleep(100)
    }
    throw new Error('the file did not open')
  })
  ok = edit && preview && load
} catch (e) {
  console.log(`failed: ${e.stack ?? e}`)
} finally {
  capturing = false
  if (child.pid && !exited) process.kill(child.pid)
  console.log(`stopped pid ${child.pid}`)
}
process.exit(ok ? 0 : 1)
