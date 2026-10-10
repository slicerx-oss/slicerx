// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A flat filament color reads as one hue on every lit face: the lights are neutral white, so shading changes brightness
// only. The showcase X in teal, red, white and black, from six angles, in both themes: across the model's lit faces
// a colored filament stays within a few degrees of its own hue, and white and black stay gray.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type FileChooser, type Page } from '@playwright/test'
import { expect, plateReady, test, viewportReady } from './fixtures'

const MODELS = join(import.meta.dirname, '..', '..', '..', 'packages/core/bench/models')
const COLORS = { teal: '#1f9e9a', red: '#d63a32', white: '#f2f2f0', black: '#202022' } as const
const ANGLES = ['iso', 'front', 'back', 'left', 'right', 'top'] as const

type Sx = { getState(): { plate: { id: string; name: string; colors: string[] }[]; plateLoading: boolean }; setState(p: unknown): void }
type Vp = { view(p: string, o?: { animate?: boolean }): void; camera: { matrixWorld: { elements: number[] } }; objects: Map<string, { group: { visible: boolean } }>; shadowDirty: boolean; invalidate(): void }

/** Hue (degrees) and saturation of an sRGB hex. */
function hsv(hex: string): { h: number; s: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
  const mx = Math.max(r, g, b)
  const d = mx - Math.min(r, g, b)
  const h = d === 0 ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: h * 60, s: mx === 0 ? 0 : d / mx }
}

/**
 * The model's pixels in the view: those that differ from the same view with the plate empty. For each, its hue's
 * distance from `hue` (colored pixels only: lit, saturation above 0.2) and its saturation (lit pixels).
 */
async function measure(page: Page, withModel: string, again: string, without: string, after: string, hue: number): Promise<{ n: number; hueDev: number[]; sat: number[]; moving: number }> {
  return page.evaluate(
    async ({ withModel, again, without, after, hue }) => {
      const load = async (b64: string) => {
        const img = new Image()
        img.src = `data:image/png;base64,${b64}`
        await img.decode()
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const g = c.getContext('2d')!
        g.drawImage(img, 0, 0)
        return g.getImageData(0, 0, c.width, c.height).data
      }
      const a = await load(withModel)
      const b = await load(without)
      const c = await load(after)
      const a2 = await load(again)
      const hueDev: number[] = []
      const sat: number[] = []
      let n = 0
      let moving = 0
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!)
        if (d < 30) continue
        // the view without the model, before and after: where they differ, something else moved, not the model
        // and the view with the model, shot twice: where those differ, something passed over it (a toast, a fade)
        const still = (x: Uint8ClampedArray, y: Uint8ClampedArray) => Math.abs(x[i]! - y[i]!) + Math.abs(x[i + 1]! - y[i + 1]!) + Math.abs(x[i + 2]! - y[i + 2]!) < 30
        if (!still(b, c) || !still(a, a2)) {
          moving++
          continue
        }
        n++
        const r = a[i]! / 255
        const gg = a[i + 1]! / 255
        const bb = a[i + 2]! / 255
        const mx = Math.max(r, gg, bb)
        const dd = mx - Math.min(r, gg, bb)
        // lit faces only: the dark edge lines and shadowed sides carry too little color to read a hue from
        if (mx < 0.18) continue
        const s = dd / mx
        sat.push(s)
        if (s < 0.2) continue
        const h = (mx === r ? ((gg - bb) / dd + 6) % 6 : mx === gg ? (bb - r) / dd + 2 : (r - gg) / dd + 4) * 60
        hueDev.push(((h - hue + 540) % 360) - 180)
      }
      return { n, hueDev, sat, moving }
    },
    { withModel, again, without, after, hue },
  )
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((x, y) => x - y)
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : NaN
}

async function openModel(page: Page, seen: FileChooser[], file: string): Promise<void> {
  const before = seen.length
  for (let i = 0; i < 10 && seen.length === before; i++) {
    await page.keyboard.press('ControlOrMeta+o')
    await page.waitForTimeout(500)
  }
  await seen[before]!.setFiles({ name: file, mimeType: 'model/stl', buffer: readFileSync(join(MODELS, file)) })
  // the opened file by name: the plate the app starts with is one object too
  const name = file.replace(/\.stl$/, '')
  await expect
    .poll(() => page.evaluate((name) => { const s = (window as unknown as { __sx: Sx }).__sx.getState(); return !s.plateLoading && s.plate.length === 1 && s.plate[0]!.name.startsWith(name) }, name), { timeout: 60_000 })
    .toBe(true)
}

for (const scheme of ['dark', 'light'] as const) {
  test(`a flat filament keeps its hue on every lit face (${scheme})`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'Desktop view')
    test.slow()
    const seen: FileChooser[] = []
    page.on('filechooser', (c) => seen.push(c))
    await page.addInitScript((scheme) => {
      if (sessionStorage.getItem('sx-e2e')) return
      sessionStorage.setItem('sx-e2e', '1')
      localStorage.setItem('slicerx.debug', '1')
      localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' }, autoSlice: false, scheme, themeFollowsSystem: false }))
    }, scheme)
    await page.goto('./')
    await plateReady(page)
    await viewportReady(page)
    // a toast floats over the view (on a runner without a GPU, the hardware acceleration note); it is not the model
    await page.addStyleTag({ content: '.sx-toasts { display: none !important; }' })
    const rows: string[] = []
    const vp = page.locator('.vp-canvas')
    const file = 'x-mark-showcase.stl'
    await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
    await openModel(page, seen, file)
    await page.evaluate(() => (window as unknown as { __sx: Sx }).__sx.setState({ selection: null, selectedIds: [] }))
    const paint = (hex: string) =>
      page.evaluate((hex) => {
        const sx = (window as unknown as { __sx: Sx }).__sx
        // filament 1 set by hand, as the person picks a color in the filament list
        sx.setState({ slotSetup: { 1: { type: 'PLA', brand: '', color: hex } } })
      }, hex)
    // the same view without the model (hidden in the scene, so nothing else on screen changes)
    const shown = (on: boolean) =>
      page.evaluate((on) => {
        const vp = (window as unknown as { __vp: Vp }).__vp
        vp.objects.forEach((o) => (o.group.visible = on))
        vp.shadowDirty = true
        vp.invalidate()
      }, on)
    // the view at rest: the camera where it is, not where it is going, reads the same twice in a row (an open frames
    // the new model with a camera move that can still run into the first view)
    const camera = () => page.evaluate(() => (window as unknown as { __vp: Vp }).__vp.camera.matrixWorld.elements.map((v) => v.toFixed(3)).join(','))
    const still = async () => {
      let last = await camera()
      for (let i = 0; i < 50; i++) {
        await page.waitForTimeout(300)
        const now = await camera()
        if (now === last) return
        last = now
      }
    }
    // the contact shadow under the model is baked into the floor and stays when the model is hidden; it bakes a moment
    // after the model shows, so the first view waits for it, and every shot of a view then differs from its empty
    // plate by the model alone
    await paint(COLORS.teal)
    await still()
    await page.waitForTimeout(1500)
    for (const angle of ANGLES) {
      await shown(false)
      await page.evaluate((a) => (window as unknown as { __vp: Vp }).__vp.view(a, { animate: false }), angle)
      await still()
      await page.waitForTimeout(600)
      const without = (await vp.screenshot()).toString('base64')
      await shown(true)
      const shots: [string, string, string, string][] = []
      for (const [name, hex] of Object.entries(COLORS)) {
        await paint(hex)
        await page.waitForTimeout(600)
        const first = (await vp.screenshot()).toString('base64')
        await page.waitForTimeout(300)
        shots.push([name, hex, first, (await vp.screenshot()).toString('base64')])
      }
      await shown(false)
      await page.waitForTimeout(600)
      const after = (await vp.screenshot()).toString('base64')
      await shown(true)
      for (const [name, hex, withModel, again] of shots) {
        const target = hsv(hex)
        const m = await measure(page, withModel, again, without, after, target.h)
        const colored = target.s > 0.3
        const lo = pct(m.hueDev, 0.02)
        const hi = pct(m.hueDev, 0.98)
        const sat98 = pct(m.sat, 0.98)
        rows.push(`${name} ${angle}: model px ${m.n}, moving ${m.moving}, colored ${m.hueDev.length}, hue p2..p98 ${lo.toFixed(1)}..${hi.toFixed(1)}, sat p98 ${sat98.toFixed(3)}`)
        if (process.env['SX_HUE_SHOTS']) writeFileSync(join(process.env['SX_HUE_SHOTS'], `${file}-${name}-${angle}-${scheme}.png`), Buffer.from(withModel, 'base64'))
        if (colored) {
          expect.soft(m.hueDev.length, `${name} ${angle}: colored pixels`).toBeGreaterThan(500)
          expect.soft(Math.max(Math.abs(lo), Math.abs(hi)), `${name} ${angle} ${scheme}: hue spread`).toBeLessThanOrEqual(4)
        } else expect.soft(sat98, `${name} ${angle} ${scheme}: stays gray`).toBeLessThan(0.08)
      }
    }
    console.log(`filament-hue ${scheme}\n${rows.join('\n')}`)
    if (process.env['SX_HUE_SHOTS']) writeFileSync(join(process.env['SX_HUE_SHOTS'], `rows-${scheme}.txt`), rows.join('\n'))
  })
}
