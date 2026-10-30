// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plate edge drag's colors in a real browser, as a host page sees them: the module built on its own (or, with
// SX_EDGE_DRAG_PACKAGE set to an unpacked @slicerx/viewport tarball, the published ./edge-drag export), a stand-in view
// and a four or five plate host. It reads the computed color of every mark with the defaults (the page's --accent and
// --fg), with each --sx-edge-* property set in the host's CSS, and with the theme option over that CSS.
// Skipped where no Chromium for playwright-core is installed.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright-core'
import { build } from 'vite'
import { EDGE_DRAG_PROPERTIES } from '../src/edge-drag/index'

type Key = keyof typeof EDGE_DRAG_PROPERTIES
const KEYS = Object.keys(EDGE_DRAG_PROPERTIES) as Key[]
const ORIGIN = 'http://kit.test'

/** A distinct color per key, as getComputedStyle writes it. */
const color = (i: number, g: number): string => `rgb(${10 + i * 12}, ${g}, ${250 - i * 9})`

// The page: a positioned stage with the canvas, a stand-in view, and a host. probe(mode) runs a drag past the right
// edge, the More plates list, a drop into a plate bar and a short release, and reads each mark's color.
const PAGE = (entry: string) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { --accent: rgb(1, 2, 3); --fg: rgb(4, 5, 6); }
  body { margin: 0; }
  #stage { position: relative; width: 1000px; height: 800px; }
  #bar { position: absolute; left: 400px; top: 740px; width: 200px; height: 32px; }
</style></head><body><div id="host"><div id="stage"><canvas width="1000" height="800"></canvas><div id="bar"></div></div></div>
<script type="module">
import * as kit from ${JSON.stringify(entry)}
const BED = { widthMm: 180, depthMm: 180 }
const screenOf = (p) => [200 + p[0] * 3, 670 - p[1] * 3]
const info = (x0, y0, x1, y1) => ({ ids: ['a'], box: { min: [x0, y0], max: [x1, y1] }, client: [200 + ((x0 + x1) / 2) * 3, 670 - ((y0 + y1) / 2) * 3], pointerType: 'mouse', bed: BED })
const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const stage = document.getElementById('stage')
const cs = (sel, prop) => {
  const el = stage.querySelector(sel)
  return el ? getComputedStyle(el).getPropertyValue(prop) : 'missing: ' + sel
}
window.probe = async ({ hostCss, theme }) => {
  const host = document.getElementById('host')
  host.removeAttribute('style')
  for (const [k, v] of Object.entries(hostCss ?? {})) host.style.setProperty(k, v)
  let hook = null
  const view = { canvas: stage.querySelector('canvas'), screenOf, setEdgeDrag: (h) => (hook = h), cancelDrag: () => (hook?.cancel(), true), setSelection() {} }
  const plates = [1, 2, 3, 4, 5].map((n) => ({ id: 'plate-' + n, label: 'Plate ' + n, order: n - 1 }))
  const off = kit.enableEdgeDrag(view, {
    plates: () => plates,
    activePlate: () => 'plate-1',
    move: () => undefined,
    dropTarget: () => document.getElementById('bar').getBoundingClientRect(),
    theme,
  })
  kit.resetHint()
  const out = {}
  hook.start(info(30, 30, 50, 50))
  await kit.loadEdgeDrag()
  await wait(0)
  // past the right edge's line: the band, both lines, the halo, an armed label and a plain one, the chevron
  hook.move(info(189, 30, 209, 50))
  await frame()
  out.band = cs('.sx-edge-stop', 'stop-color')
  out.line = cs('.sx-edge-line', 'stroke')
  out.commit = cs('.sx-edge-commit', 'stroke')
  out.halo = cs('.sx-edge-halo', 'stroke')
  out.label = cs('[data-testid="edge-drag-left"]', 'color')
  out.labelArmed = cs('[data-testid="edge-drag-right"][data-armed]', 'color')
  out.chevron = cs('[data-testid="edge-drag-right"] .sx-edge-chev path', 'stroke')
  // past the top's line, More plates opens its list after a short wait
  hook.move(info(30, 189, 50, 209))
  await frame()
  await wait(450)
  await frame()
  out.menu = cs('[data-testid="edge-drag-more"]', 'background-color')
  out.menuText = cs('[data-testid="edge-drag-more"]', 'color')
  // back past the right line and released: the part flies into the plate bar, which gets a ring and a badge
  hook.move(info(189, 30, 209, 50))
  await frame()
  hook.end({ ...info(189, 30, 209, 50), onBed: false })
  await wait(60)
  out.drop = cs('.sx-edge-fly', 'border-top-color')
  out.ring = cs('.sx-edge-ring', 'border-top-color')
  out.ringGlow = cs('.sx-edge-ring', 'box-shadow')
  out.badge = cs('.sx-edge-badge', 'background-color')
  out.badgeText = cs('.sx-edge-badge', 'color')
  await wait(1100)
  // a short release: the hint
  hook.start(info(30, 30, 50, 50))
  await wait(0)
  hook.move(info(183, 30, 203, 50))
  await frame()
  hook.end({ ...info(183, 30, 203, 50), onBed: false })
  out.hint = cs('[data-testid="edge-drag-hint"]', 'background-color')
  out.hintText = cs('[data-testid="edge-drag-hint"]', 'color')
  await wait(1900)
  out.left = kit.overlaysMounted()
  off()
  return out
}
window.ready = true
</script></body></html>`

const TYPES: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' }

let browser: Browser | null = null
let page: Page | null = null
let dir = ''
let built = ''

beforeAll(async () => {
  if (!existsSync(chromium.executablePath())) return
  const pkg = process.env['SX_EDGE_DRAG_PACKAGE']
  let root: string
  let entry: string
  if (pkg) {
    // the packed package: its own package.json says where ./edge-drag is
    root = resolve(pkg)
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { exports: Record<string, { import?: string } | string> }
    const e = manifest.exports['./edge-drag']
    entry = typeof e === 'string' ? e : (e?.import ?? '')
    if (!entry) throw new Error('the package has no ./edge-drag export')
  } else {
    built = mkdtempSync(join(tmpdir(), 'sx-edge-drag-'))
    await build({
      configFile: false,
      logLevel: 'silent',
      root: resolve(import.meta.dirname, '..'),
      build: { outDir: built, emptyOutDir: true, minify: false, target: 'es2022', lib: { entry: { 'edge-drag': 'src/edge-drag/index.ts' }, formats: ['es'] }, rollupOptions: { output: { chunkFileNames: 'chunks/[name]-[hash].js' } } },
    })
    root = built
    entry = './edge-drag.js'
  }
  dir = root
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: PAGE(new URL(entry, `${ORIGIN}/pkg/`).pathname) })
    const file = join(dir, decodeURIComponent(path.replace(/^\/pkg\//, '')))
    if (!path.startsWith('/pkg/') || !existsSync(file)) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(`${ORIGIN}/`)
  await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true, null, { timeout: 15_000 }).catch(() => {
    throw new Error(`the page did not load: ${errors.join('; ')}`)
  })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  if (built) rmSync(built, { recursive: true, force: true })
})

const probe = (arg: { hostCss?: Record<string, string>; theme?: Record<string, string> }) =>
  page!.evaluate((a) => (window as unknown as { probe(x: typeof a): Promise<Record<string, string | number>> }).probe(a), arg)

describe('edge drag colors in a browser', () => {
  it('with nothing set, the marks follow the page tokens, so the app looks as it did', async (ctx) => {
    if (!page) return ctx.skip()
    const got = await probe({})
    const accent = 'rgb(1, 2, 3)'
    for (const k of ['band', 'line', 'commit', 'drop', 'ring', 'badge'] as const) expect(got[k], k).toBe(accent)
    expect(got['label']).toBe('rgb(4, 5, 6)')
    expect(got['left']).toBe(0)
  }, 30_000)

  it('each --sx-edge-* property set in the host CSS colors its mark', async (ctx) => {
    if (!page) return ctx.skip()
    const css = Object.fromEntries(KEYS.map((k, i) => [EDGE_DRAG_PROPERTIES[k], color(i, 100)]))
    const got = await probe({ hostCss: css })
    KEYS.forEach((k, i) => (k === 'ringGlow' ? expect(got[k], k).toContain(color(i, 100)) : expect(got[k], k).toBe(color(i, 100))))
  }, 30_000)

  it('the theme option wins over the host CSS for every key', async (ctx) => {
    if (!page) return ctx.skip()
    const css = Object.fromEntries(KEYS.map((k, i) => [EDGE_DRAG_PROPERTIES[k], color(i, 100)]))
    const theme = Object.fromEntries(KEYS.map((k, i) => [k, color(i, 180)]))
    const got = await probe({ hostCss: css, theme })
    KEYS.forEach((k, i) => (k === 'ringGlow' ? expect(got[k], k).toContain(color(i, 180)) : expect(got[k], k).toBe(color(i, 180))))
    expect(got['left']).toBe(0)
  }, 30_000)
})
