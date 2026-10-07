// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Captures the card art for the setup screen that asks what the plate tab opens in (first-run/open-step.tsx), from the
// app's own viewport: one enclosure, solid with its rounded edges for CAD design, and the same enclosure sliced
// into its toolpaths for Slicing. Runs only on request:
//   SX_CAPTURE=1 pnpm --filter @slicerx/web exec playwright test e2e/open-art.spec.ts --project=desktop
// and writes packages/app/src/first-run/open-art/{design,slicing}.webp.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { bounds, command, facePick, freshBox, openStudio, pick, steps, toolPanel } from './cad-helpers'
import { expect, sliceCount, sliced, test } from './fixtures'

const OUT = join(import.meta.dirname, '..', '..', '..', 'packages', 'app', 'src', 'first-run', 'open-art')
const W = 960
const H = 600

/** The view, without the panes, as WebP at the card's size (twice its CSS size, for sharp screens). */
async function capture(page: Page, name: string): Promise<void> {
  const canvas = page.locator('.vp-canvas').first()
  // Hide whatever sits over the view (panels, legends, bars) for the shot.
  const hidden = await canvas.evaluate((cv) => {
    const r = cv.getBoundingClientRect()
    let n = 0
    for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
      if (el === cv || el.contains(cv) || cv.contains(el)) continue
      const b = el.getBoundingClientRect()
      if (b.width && b.height && b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom) {
        el.dataset['sxCapHidden'] = el.style.visibility
        el.style.visibility = 'hidden'
        n++
      }
    }
    return n
  })
  await page.waitForTimeout(100)
  const png = await canvas.screenshot({ type: 'png' })
  if (hidden) {
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-sx-cap-hidden]')) {
        el.style.visibility = el.dataset['sxCapHidden'] ?? ''
        delete el.dataset['sxCapHidden']
      }
    })
  }
  const webp = await page.evaluate(
    async ([b64, w, h]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const scale = Math.max(w / img.width, h / img.height)
      const dw = img.width * scale
      const dh = img.height * scale
      c.getContext('2d')!.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
      return c.toDataURL('image/webp', 0.86).split(',')[1]!
    },
    [png.toString('base64'), W, H] as const,
  )
  writeFileSync(join(OUT, `${name}.webp`), Buffer.from(webp, 'base64'))
}

/** Looks down into the enclosure from the front left, close enough to fill the card. */
async function frame(page: Page, id: string): Promise<void> {
  const b = await bounds(page, id)
  const c = [0, 1, 2].map((i) => (b.min[i]! + b.max[i]!) / 2)
  await page.evaluate((target) => {
    const vp = (window as unknown as { __vp: { setCamera(s: object): void } }).__vp
    vp.setCamera({ target, azimuthDeg: -32, elevationDeg: 42, distanceMm: 190 })
  }, c)
  await page.mouse.move(5, 5)
  await page.waitForTimeout(1200)
}

/** Pulls the face facing `dir` out by `mm`, with push and pull. */
async function pushFace(page: Page, objectId: string, dir: [number, number, number], mm: number): Promise<void> {
  await command(page, 'Push or pull a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('No face yet')
  await pick(page, await facePick(page, objectId, dir))
  await expect(panel).toContainText('A face is picked')
  await panel.locator('#push-dist').fill(String(mm))
  await panel.getByRole('button', { name: 'Pull out' }).click()
  await expect(panel).toContainText('No face yet', { timeout: 60_000 })
  await panel.getByRole('button', { name: 'Done' }).click()
}

test('captures the open step card art', async ({ page, isMobile }) => {
  test.skip(!process.env['SX_CAPTURE'] || isMobile, 'Runs on request, at desktop width')
  test.setTimeout(600_000)
  await page.setViewportSize({ width: 1600, height: 1000 })
  await openStudio(page)
  const id = await freshBox(page)
  // An enclosure: the 20 mm box pulled out to 60 by 40 by 26 mm face by face, then its top left open with 2 mm walls.
  for (const [dir, mm] of [[[1, 0, 0], 40], [[0, 1, 0], 20], [[0, 0, 1], 6]] as const) await pushFace(page, id, [...dir], mm)
  await command(page, 'Shell: hollow with faces left open')
  let tool = toolPanel(page)
  await expect(tool).toContainText('Click the flat faces to leave open')
  await pick(page, await facePick(page, id, [0, 0, 1]))
  await expect(tool).toContainText('1 open face')
  await tool.locator('#shell-wall').fill('2')
  await tool.getByRole('button', { name: 'Make shell' }).click()
  await expect.poll(() => steps(page), { timeout: 120_000 }).toHaveLength(4)

  // Its four upright outer edges rounded, captured in Design.
  const b = await bounds(page, id)
  await command(page, 'Fillet or chamfer edges')
  tool = toolPanel(page)
  await expect(tool).toContainText('No edge yet')
  const z = (b.min[2] + b.max[2]) / 2
  const corners: [number, number, [number, number, number]][] = [
    [b.max[0] - 0.4, b.max[1], [0, 1, 0]],
    [b.min[0] + 0.4, b.max[1], [0, 1, 0]],
    [b.max[0] - 0.4, b.min[1], [0, -1, 0]],
    [b.min[0] + 0.4, b.min[1], [0, -1, 0]],
  ]
  // Each pick asks the engine, so wait for it before the next Shift pick adds to it.
  for (const [i, [x, y, dir]] of corners.entries()) {
    await pick(page, { ...(await facePick(page, id, dir, [x, y, z])), ...(i ? { shift: true } : {}) })
    await expect(tool.getByText(i ? `${i + 1} edges` : '1 edge', { exact: true })).toBeVisible({ timeout: 30_000 })
  }
  await tool.locator('#edge-size').fill('4')
  await tool.getByRole('button', { name: 'Round' }).click()
  await expect.poll(() => steps(page), { timeout: 120_000 }).toHaveLength(5)
  await tool.getByRole('button', { name: 'Done' }).click()
  await expect(tool).toHaveCount(0)
  await frame(page, id)
  await capture(page, 'design')

  // The same enclosure sliced, in the toolpath look.
  await page.locator('.sx-tab[data-mode="slice"]').click()
  const before = await sliceCount(page)
  await command(page, 'Slice the plate')
  await expect(sliced(page, before)).toBeVisible({ timeout: 180_000 })
  // Line type colors, cut about two thirds up so the walls show.
  const top = page.getByRole('slider', { name: 'Top layer' })
  await top.focus()
  for (let i = 0; i < 4; i++) await page.keyboard.press('PageDown')
  await page.evaluate(() => (window as unknown as { __vp: { setColorMode(m: string): void } }).__vp.setColorMode('feature'))
  const head = page.getByRole('checkbox', { name: 'Show toolhead' })
  if (await head.isChecked()) await head.uncheck()
  await frame(page, id)
  await capture(page, 'slicing')
})
