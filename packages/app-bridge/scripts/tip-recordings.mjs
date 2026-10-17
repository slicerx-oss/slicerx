// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Records the tooltip clips that show where to click (packages/app/src/demos/rec): the running desktop app, driven
// the way a person drives it, captured frame by frame and encoded as animated WebP with a still poster, once per
// theme. The bridge starts and sets up the app; the clicks and drags go through DevTools, so the app must start
// with a debugging port, which a Windows bridge build takes from WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS. A drawn
// pointer stands in for the system one, which a capture does not show. Needs ffmpeg with libwebp on the PATH.
//   node packages/app-bridge/scripts/tip-recordings.mjs --app <bridge binary> --cdp-port <port> [--out <dir>]
//     [--only <id,id>] [--theme dark|light|both] [--budget <KB per clip and theme>]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createAppClient } from '../src/client.ts'
import { finishFirstRun } from './first-run.mjs'

const { values } = parseArgs({
  options: { app: { type: 'string' }, 'cdp-port': { type: 'string' }, out: { type: 'string' }, only: { type: 'string' }, theme: { type: 'string' }, budget: { type: 'string' } },
  strict: true,
})
if (!values.app || !values['cdp-port']) {
  console.error('usage: node tip-recordings.mjs --app <bridge binary> --cdp-port <port> [--out <dir>] [--only <ids>] [--theme dark|light|both]')
  process.exit(2)
}
const repo = resolve(import.meta.dirname, '../../..')
const out = resolve(values.out ?? join(tmpdir(), `sx-tip-recordings-${Date.now()}`))
const themes = values.theme && values.theme !== 'both' ? [values.theme] : ['dark', 'light']
const budget = Number(values.budget ?? 150) * 1024
const only = values.only ? new Set(values.only.split(',')) : null
const model = join(repo, 'packages', 'core', 'bench', 'models', 'x-mark.stl')
// the window the clips are framed in, in CSS pixels; the clip is a crop of it scaled to WIDTH
const VIEW = { width: 1440, height: 900 }
const WIDTH = 320
const FPS = 15
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- the app ----------

let child = null
let exited = false
let app = null
let page = null
let cdp = null
const call = (tool, args = {}) => app.call(tool, args)

async function start(dir) {
  const tokenFile = join(dir, 'bridge.json')
  rmSync(tokenFile, { force: true })
  const env = { ...process.env, SX_AGENT_BRIDGE_PORT: '0', SX_AGENT_BRIDGE_TOKEN_FILE: tokenFile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${values['cdp-port']}` }
  // a fresh profile, so each theme starts from the same first run
  env.WEBVIEW2_USER_DATA_FOLDER = join(dir, 'webview2')
  rmSync(env.WEBVIEW2_USER_DATA_FOLDER, { recursive: true, force: true })
  exited = false
  child = spawn(values.app, [], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  child.on('exit', () => (exited = true))
  console.log(`started ${values.app} as pid ${child.pid}`)
  for (let i = 0; i < 240 && !existsSync(tokenFile) && !exited; i++) await sleep(500)
  if (!existsSync(tokenFile)) throw new Error(`the app did not start its bridge: ${stderr.slice(-400)}`)
  app = createAppClient(tokenFile)
  for (let i = 0; i < 240; i++) {
    if ((await app.health().catch(() => null))?.appReady) break
    await sleep(500)
  }
  const first = await finishFirstRun({ testids: () => call('testids'), click: (testid) => call('click', { testid }).catch(() => undefined), sleep })
  if (!first.done) throw new Error(`first run did not finish: ${Object.keys(first.ids).join(' ')}`)
  const { chromium } = createRequire(join(repo, 'apps', 'web', 'package.json'))('@playwright/test')
  let browser = null
  for (let i = 0; i < 40 && !browser; i++) browser = await chromium.connectOverCDP(`http://127.0.0.1:${values['cdp-port']}`).catch(() => sleep(500).then(() => null))
  if (!browser) throw new Error('no DevTools on the debugging port: is WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS passed through?')
  page = browser.contexts()[0].pages()[0]
  cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false })
  const gl = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('webgl2')
    const i = c?.getExtension('WEBGL_debug_renderer_info')
    return i ? c.getParameter(i.UNMASKED_RENDERER_WEBGL) : 'no webgl2'
  })
  console.log(`renderer: ${gl}`)
}

function stop() {
  if (child?.pid && !exited) process.kill(child.pid)
  console.log(`stopped pid ${child?.pid}`)
}

/** The bridge build keeps its prefs on disk between runs; each clip starts in the theme it records, not the system's. */
function prefsFor(name) {
  const file = join(process.env.APPDATA ?? '', 'app.slicerx.desktop.agent-bridge', 'prefs.json')
  if (!process.env.APPDATA || !existsSync(file)) return
  const p = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...p, scheme: name, themeFollowsSystem: false, followNozzle: false }))
}

async function theme(name) {
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: name }] })
  await sleep(600)
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

async function command(title) {
  await page.keyboard.press('Control+k')
  await page.keyboard.type(title)
  await sleep(300)
  await page.keyboard.press('Enter')
  await sleep(500)
}

// ---------- the drawn pointer ----------

// An arrow that follows the mouse and dips on a press, over everything and taking no events.
const POINTER = `(() => {
  if (document.getElementById('sx-rec-pointer')) return
  const p = document.createElement('div')
  p.id = 'sx-rec-pointer'
  p.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:scale 90ms'
  p.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13.5 19 L10.6 12.8 L16.5 12.5 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>'
  document.documentElement.appendChild(p)
  const at = (e) => { p.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 2) + 'px)' }
  addEventListener('pointermove', at, true)
  addEventListener('pointerdown', (e) => { at(e); p.style.scale = '0.86' }, true)
  addEventListener('pointerup', () => { p.style.scale = '1' }, true)
  // the clip is what a tip shows, so the app's own tips stay out of it
  const st = document.createElement('style')
  st.textContent = '#sx-tip{display:none!important}'
  document.head.appendChild(st)
})()`

/** Moves the pointer to a point over a few frames, the way a hand does. */
async function glide(x, y, ms = 450) {
  await page.mouse.move(x, y, { steps: Math.max(4, Math.round(ms / 30)) })
}

async function centerOf(locator) {
  const b = await locator.boundingBox()
  if (!b) throw new Error(`not on screen: ${locator}`)
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, box: b }
}

async function clickOn(locator, ms) {
  const c = await centerOf(locator)
  await glide(c.x, c.y, ms)
  await sleep(180)
  await page.mouse.down()
  await sleep(90)
  await page.mouse.up()
}

// ---------- capture and encode ----------

/** Records `act` and writes its frames, each with the time it was on screen. */
async function record(dir, act) {
  mkdirSync(dir, { recursive: true })
  const frames = []
  const onFrame = (f) => {
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined)
    frames.push({ t: (f.metadata.timestamp ?? Date.now() / 1000) * 1000, data: f.data })
  }
  cdp.on('Page.screencastFrame', onFrame)
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 })
  await sleep(300)
  const t0 = Date.now()
  await act()
  const t1 = Date.now()
  console.log(`  act ${((t1 - t0) / 1000).toFixed(1)} s, ${frames.length} frames so far`)
  await sleep(200)
  await cdp.send('Page.stopScreencast')
  cdp.off('Page.screencastFrame', onFrame)
  // only the frames from the act; the one on screen as it started opens the clip
  const start = t0 - 1
  const keep = frames.filter((f, i) => f.t >= start || frames[i + 1]?.t >= start || i === frames.length - 1)
  const lines = ['ffconcat version 1.0']
  keep.forEach((f, i) => {
    const name = `${String(i).padStart(4, '0')}.jpg`
    writeFileSync(join(dir, name), Buffer.from(f.data, 'base64'))
    const from = Math.max(f.t, start)
    const to = Math.min(keep[i + 1]?.t ?? t1, t1)
    lines.push(`file '${name}'`, `duration ${(Math.max(to - from, 1) / 1000).toFixed(3)}`)
  })
  // the concat demuxer holds the last frame only when it is listed twice
  lines.push(`file '${String(keep.length - 1).padStart(4, '0')}.jpg'`)
  writeFileSync(join(dir, 'frames.ffconcat'), `${lines.join('\n')}\n`)
  return { frames: keep.length, seconds: (t1 - t0) / 1000 }
}

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr || r.error?.message}`)
}

/** Encodes the clip and its poster (its last frame), lowering the quality until the clip fits the budget. */
function encode(dir, crop, file) {
  const c = { x: Math.round(crop.x), y: Math.round(crop.y), w: Math.round(crop.w) & ~1, h: Math.round(crop.h) & ~1 }
  const vf = `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${WIDTH}:-2:flags=lanczos`
  let q = 70
  for (;;) {
    ffmpeg(['-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.ffconcat'), '-vf', `${vf},fps=${FPS}`, '-c:v', 'libwebp_anim', '-lossless', '0', '-q:v', String(q), '-compression_level', '6', '-loop', '0', '-an', `${file}.webp`])
    if (statSync(`${file}.webp`).size <= budget || q <= 25) break
    q -= 8
  }
  // a contact sheet of the clip at 4 frames a second, to review it without a player
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.ffconcat'), '-vf', `${vf},fps=4,tile=6x4:padding=4`, '-frames:v', '1', `${file}-sheet.png`])
  const last = readFileSync(join(dir, 'frames.ffconcat'), 'utf8').trim().split('\n').at(-1).match(/'(.+)'/)[1]
  ffmpeg(['-i', join(dir, last), '-vf', vf, '-c:v', 'libwebp', '-q:v', '72', '-frames:v', '1', `${file}-poster.webp`])
  return { q, kb: Math.round(statSync(`${file}.webp`).size / 1024), posterKb: Math.round(statSync(`${file}-poster.webp`).size / 1024), size: `${WIDTH}x${Math.round((c.h * WIDTH) / c.w / 2) * 2}` }
}

// ---------- the clips ----------

const tab = (label) => page.locator('.sx-tab', { hasText: label }).first().click()
/** Frames the camera on the parts. */
async function fit() {
  await page.getByRole('button', { name: 'Fit', exact: true }).first().click()
  await sleep(900)
}

/** Opens the playback bar's sliders. */
async function sliders() {
  const tab = page.locator('.dock-tab').first()
  if ((await tab.getAttribute('aria-expanded')) === 'false') await tab.click()
  await sleep(500)
}
/** A box of the given size at the middle of the 3D view, where the plate sits. */
async function middle(w, h) {
  const v = await page.evaluate(() => {
    const r = [...document.querySelectorAll('canvas')].map((c) => c.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0]
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  return { x: v.x + v.width / 2 - w / 2, y: v.y + v.height / 2 - h / 2, width: w, height: h }
}

/** Pulls the camera back over the 3D view, so a model near the top has headroom. */
async function zoomOut(ticks) {
  const v = await middle(10, 10)
  await page.mouse.move(v.x, v.y)
  for (let i = 0; i < ticks; i++) {
    await page.mouse.wheel(0, 120)
    await sleep(120)
  }
  await sleep(1600)
}

/** A frame between the side panels, from just above the legend to just under a control on the playback bar. */
async function betweenPanels(control) {
  const { left, right, top } = await page.evaluate((w) => {
    const r = [...document.querySelectorAll('aside.sx-rail')].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 40 && b.height > 200)
    const hud = document.querySelector('.hud-col')?.getBoundingClientRect()
    return {
      left: Math.max(0, ...r.filter((b) => b.right < w / 2).map((b) => b.right)),
      right: Math.min(w, ...r.filter((b) => b.left > w / 2).map((b) => b.left)),
      top: Math.max(0, (hud?.top ?? 64) - 4),
    }
  }, VIEW.width)
  const c = (await centerOf(control)).box
  return { x: left + 6, y: top, w: right - left - 12, h: Math.min(VIEW.height - top, c.y + c.height + 16 - top) }
}

/** A box around a few boxes, with room around them, kept inside the window. */
function around(boxes, pad = 24, aspect = null) {
  let x0 = Math.min(...boxes.map((b) => b.x)) - pad
  let y0 = Math.min(...boxes.map((b) => b.y)) - pad
  let x1 = Math.max(...boxes.map((b) => b.x + b.width)) + pad
  let y1 = Math.max(...boxes.map((b) => b.y + b.height)) + pad
  if (aspect) {
    // grow the short side to the clip's shape
    const w = x1 - x0
    const h = y1 - y0
    if (w / h > aspect) { const g = w / aspect - h; y0 -= g / 2; y1 += g / 2 } else { const g = h * aspect - w; x0 -= g / 2; x1 += g / 2 }
  }
  x0 = Math.max(0, x0)
  y0 = Math.max(0, y0)
  return { x: x0, y: y0, w: Math.min(VIEW.width, x1) - x0, h: Math.min(VIEW.height, y1) - y0 }
}

/** The plain solid look, so a clip about the parts shows them and not their toolpaths. */
async function solid() {
  await page.getByRole('radio', { name: /^Solid/ }).first().click()
  await sleep(400)
}

/** The toolpaths look, where the legend and the playback bar show. */
async function toolpaths() {
  await page.getByRole('radio', { name: /^Toolpaths/ }).first().click()
  await sleep(400)
}

/** Sets a checkbox the way a clip needs it to start; the app keeps these between runs. */
async function check(name, want) {
  const box = page.getByRole('checkbox', { name })
  if ((await box.isChecked()) !== want) await box.click()
}

/** Sets the playback speed, by its label in the speed control (1/2x is 0.5). */
async function speed(v) {
  await page.getByRole('radiogroup', { name: 'Playback speed' }).getByRole('radio').nth(['0.25', '0.5', '1', '2', '5', '10', '50', '100'].indexOf(String(v))).click()
  await sleep(200)
}

/** Moves the print to a share of its time, so playback starts with the part well under way. */
async function seek(share) {
  await sliders()
  // a range input takes its value through the native setter and an input event, as a drag would give it
  await page.locator('#pv-time').evaluate((el, share) => {
    const v = Number(el.max || 1) * share
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, share)
  await sleep(400)
  await page.locator('.dock-tab').first().click()
  await sleep(500)
}

/** Advanced settings, as the tips' screenshots show the app. */
async function advanced() {
  await page.getByTestId('slice-mode-chip').click()
  await page.getByTestId('slice-mode-chip-advanced').click()
  await sleep(500)
}

const CLIPS = {
  // Paint: the tool, then a stroke across the part in the second filament
  paint: {
    async setup() {
      await tab('Slice')
      await solid()
      await call('click', { testid: 'object-select', index: 0 }).catch(() => undefined)
      await fit()
      await page.mouse.move(VIEW.width / 2, VIEW.height - 40)
    },
    async frame() {
      const tool = page.getByRole('button', { name: 'Paint', exact: true }).first()
      return around([(await centerOf(tool)).box, await middle(420, 240)], 16, 4 / 3)
    },
    async act() {
      await clickOn(page.getByRole('button', { name: 'Paint', exact: true }).first())
      await sleep(600)
      const v = await middle(2, 2)
      const cx = v.x + 1
      const cy = v.y + 1
      // two strokes across the middle of the part
      for (const [dy, dir] of [[-18, 1], [14, -1]]) {
        await glide(cx - 70 * dir, cy + dy, 350)
        await page.mouse.down()
        for (let i = 0; i <= 20; i++) await page.mouse.move(cx - 70 * dir + i * 7 * dir, cy + dy + Math.sin(i / 3) * 6)
        await page.mouse.up()
        await sleep(200)
      }
      await sleep(800)
    },
  },
  // Arrange all: copies sitting over each other, nested by their outlines
  arrange: {
    async setup() {
      await tab('Slice')
      await solid()
      await call('click', { testid: 'object-select', index: 0 }).catch(() => undefined)
      for (let i = 0; i < 3; i++) await command('Add an instance')
      await sleep(800)
      // pile them up near the middle of the plate, each a little off the last
      for (let i = 0; i < 4; i++) {
        await page.getByTestId('object-select').nth(i).click()
        const tf = page.getByTestId('slice-selection-transform')
        if ((await tf.getAttribute('aria-expanded')) !== 'true') await tf.click()
        await sleep(300)
        for (const [axis, v] of [['x', 110 + i * 14], ['y', 120 + i * 9]]) {
          const f = page.locator(`#tf-position-${axis}`)
          await f.fill(String(v))
          await f.press('Enter')
        }
      }
      await page.keyboard.press('Escape')
      await page.mouse.move(VIEW.width / 2, VIEW.height - 40)
      await sleep(1500)
    },
    async frame() {
      const btn = page.getByRole('button', { name: 'Arrange all' }).first()
      return around([(await centerOf(btn)).box, await middle(420, 240)], 16, 4 / 3)
    },
    async act() {
      await clickOn(page.getByRole('button', { name: 'Arrange all' }).first())
      await sleep(2200)
    },
  },
  // Toolpath colors: the legend's Color by, from filament to speed to layer time
  'color-by': {
    async setup() {
      await tab('Slice')
      await call('slice').catch(() => undefined)
      await sliced()
      await toolpaths()
      await fit()
      await page.mouse.move(VIEW.width / 2, VIEW.height - 40)
    },
    async frame() {
      const legend = page.getByRole('list', { name: 'Toolpath legend' })
      return around([(await legend.boundingBox()), await middle(420, 240)], 16, 4 / 3)
    },
    async act() {
      for (const id of ['speed', 'layer-time']) {
        await clickOn(page.getByTestId('legend-color-by'))
        await sleep(500)
        await clickOn(page.getByTestId(`legend-color-${id}`), 300)
        await sleep(1100)
      }
    },
  },
  // Add at this layer: drag the layer down, add a pause there, and its pin shows on the track
  'layer-add': {
    async setup() {
      await tab('Slice')
      await call('slice').catch(() => undefined)
      await sliced()
      await toolpaths()
      await fit()
      // the toast the pause raises is not part of the lesson, and it would sit half in the frame
      await page.evaluate(() => {
        const st = document.createElement('style')
        st.textContent = '.sx-toasts { display: none !important }'
        document.head.append(st)
      })
      await sliders()
      await page.mouse.move(VIEW.width / 2, VIEW.height - 40)
    },
    async frame() {
      const add = page.getByRole('button', { name: 'Add at this layer' })
      const track = await page.locator('.layer-track').boundingBox()
      const a = (await centerOf(add)).box
      // the menu opens above the button
      return around([track, a, { x: a.x - 160, y: a.y - 150, width: 1, height: 1 }], 16, 16 / 9)
    },
    async act() {
      // the layer first: drag the slider's handle back to about two thirds up
      const track = await page.locator('#pv-layer').boundingBox()
      await glide(track.x + track.width - 6, track.y + track.height / 2, 450)
      await page.mouse.down()
      await page.mouse.move(track.x + track.width * 0.64, track.y + track.height / 2, { steps: 12 })
      await page.mouse.up()
      await sleep(500)
      await clickOn(page.getByRole('button', { name: 'Add at this layer' }))
      await sleep(500)
      await clickOn(page.getByRole('menuitem', { name: 'Add pause' }), 300)
      await page.getByRole('menu').waitFor({ state: 'detached', timeout: 3000 }).catch(() => undefined)
      await sleep(1400)
    },
  },
  // Show toolhead: the print plays, then the toolhead shows at the current move
  toolhead: {
    async setup() {
      await tab('Slice')
      await call('slice').catch(() => undefined)
      await sliced()
      await toolpaths()
      await fit()
      await zoomOut(Number(process.env.TIP_ZOOM ?? -3))
      await check('Show toolhead', false)
      await check('Follow nozzle', false)
      await speed(0.5)
      await seek(0.6)
      await page.mouse.move(VIEW.width / 2, VIEW.height - 40)
    },
    async frame() {
      return betweenPanels(page.getByRole('checkbox', { name: 'Show toolhead' }))
    },
    async act() {
      await clickOn(page.getByRole('button', { name: 'Play print' }))
      await sleep(900)
      await clickOn(page.getByRole('checkbox', { name: 'Show toolhead' }))
      await sleep(2200)
    },
  },
  // Follow the nozzle: the print plays with the view still, then Follow nozzle keeps the nozzle in place on screen
  follow: {
    async setup() {
      await tab('Slice')
      await call('slice').catch(() => undefined)
      await sliced()
      await toolpaths()
      await fit()
      await zoomOut(Number(process.env.TIP_ZOOM ?? -7))
      await check('Show toolhead', true)
      await check('Follow nozzle', false)
      await speed(1)
      await seek(0.45)
      // already playing when the clip starts, once the view has settled, so turning Follow nozzle on is the only change
      await page.getByRole('button', { name: 'Play print' }).click()
      const p = await centerOf(page.getByRole('checkbox', { name: 'Follow nozzle' }))
      await page.mouse.move(p.x + 90, p.y - 50)
      await sleep(1500)
    },
    async frame() {
      return betweenPanels(page.getByRole('checkbox', { name: 'Follow nozzle' }))
    },
    async act() {
      await sleep(900)
      await clickOn(page.getByRole('checkbox', { name: 'Follow nozzle' }), 350)
      await sleep(2600)
    },
  },
}

// ---------- run ----------

mkdirSync(out, { recursive: true })
const report = {}
let failed = false
for (const t of themes) {
  for (const [id, clip] of Object.entries(CLIPS)) {
    if (only && !only.has(id)) continue
    const dir = join(out, `${id}-${t}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    try {
      // a fresh app per clip, so one clip's plate and view never carry into the next
      prefsFor(t)
      await start(dir)
      await theme(t)
      await page.evaluate(POINTER)
      await tab('Slice')
      await advanced()
      await clip.setup()
      await sleep(600)
      const crop = await clip.frame()
      const rec = await record(join(dir, 'frames'), () => clip.act())
      const enc = encode(join(dir, 'frames'), crop, join(out, `${id}-${t}`))
      report[`${id}-${t}`] = { ...rec, ...enc, crop }
      console.log(`${id}-${t}: ${rec.frames} frames over ${rec.seconds.toFixed(1)} s, ${enc.size}, q ${enc.q}, ${enc.kb} KB, poster ${enc.posterKb} KB`)
    } catch (e) {
      failed = true
      report[`${id}-${t}`] = { error: String(e.stack ?? e) }
      console.log(`${id}-${t}: failed: ${e.stack ?? e}`)
      await page?.screenshot({ path: join(dir, 'failed.png') }).catch(() => undefined)
    } finally {
      stop()
      await sleep(1500)
    }
  }
}
writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`clips in ${out}`)
process.exit(failed ? 1 : 0)
