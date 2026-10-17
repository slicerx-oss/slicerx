// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { FEATURE, SXPV_SEGMENT, SXPV_SEGMENT_BYTES, type PreviewBuffers } from '@slicerx/contracts'
import { command, openStudio, pick, roundWall, sketchAt, toolPanel } from '../cad-helpers'
import { addMenu, expect, plateReady, sliceCount, sliced, tab, test } from '../fixtures'

test.use({ actionTimeout: 15000 })

const read = (page: Page) => page.evaluate(() => {
  type Body = { id: string; transform: number[]; parts: { positions: number[]; indices: number[] }[]; history?: { exact?: boolean; steps: { broken?: string; note?: string; params: { op: string } }[] } }
  const bodies = (window as unknown as { __sx: { getState(): { plate: Body[] } } }).__sx.getState().plate
  return bodies.map(b => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    let volume = 0
    let closed = true
    for (const part of b.parts) {
      const p = part.positions, ix = part.indices
      const edges = new Map<string, { count: number; balance: number }>()
      for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
        const v = b.transform[k]! * p[i]! + b.transform[4 + k]! * p[i + 1]! + b.transform[8 + k]! * p[i + 2]! + b.transform[12 + k]!
        min[k] = Math.min(min[k]!, v); max[k] = Math.max(max[k]!, v)
      }
      for (let i = 0; i < ix.length; i += 3) {
        const a = ix[i]! * 3, c = ix[i + 1]! * 3, d = ix[i + 2]! * 3
        volume += (p[a]! * (p[c + 1]! * p[d + 2]! - p[c + 2]! * p[d + 1]!) - p[a + 1]! * (p[c]! * p[d + 2]! - p[c + 2]! * p[d]!) + p[a + 2]! * (p[c]! * p[d + 1]! - p[c + 1]! * p[d]!)) / 6
        for (let j = 0; j < 3; j++) {
          const x = ix[i + j]!, y = ix[i + (j + 1) % 3]!
          const key = `${Math.min(x, y)},${Math.max(x, y)}`
          const edge = edges.get(key) ?? { count: 0, balance: 0 }
          edge.count++; edge.balance += x < y ? 1 : -1
          edges.set(key, edge)
          if (x === y) closed = false
        }
      }
      closed &&= [...edges.values()].every(e => e.count === 2 && e.balance === 0)
    }
    return { id: b.id, min, size: min.map((v, k) => Math.round((max[k]! - v) * 1000) / 1000), volume, closed, history: b.history }
  })
})

const select = (page: Page, id: string) => page.evaluate(id => (window as unknown as { __sx: { setState(v: unknown): void } }).__sx.setState({ selection: id, selectedIds: [id] }), id)
const clear = (page: Page) => page.evaluate(() => (window as unknown as { __sx: { setState(v: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))

async function bedSketch(page: Page) {
  await command(page, 'Sketch on the bed or a face')
  await expect(toolPanel(page)).toContainText('Click an origin plane')
  await pick(page, { objectId: null, partIndex: null, triangle: null, point: null, bed: [100, 100] })
  await expect(toolPanel(page)).toContainText('The bed')
}

test('an exact bracket hole edit survives downstream replay, undo, project reopen and reslicing', { tag: '@nightly' }, async ({ page, isMobile }) => {
  test.skip(isMobile, 'The exact developer workflow uses the desktop modeling tools')
  test.setTimeout(230000)
  const fallbacks: string[] = []
  page.on('console', m => { if (/exact solids:.*ran on the mesh/.test(m.text())) fallbacks.push(m.text()) })
  await page.addInitScript(() => Reflect.deleteProperty(window, 'showSaveFilePicker'))
  await openStudio(page, { settingsMode: 'developer' })
  await command(page, 'Developer: exact solids in history replays')
  await clear(page)
  await bedSketch(page)
  const panel = toolPanel(page)
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: /^Line/ }).click()
  for (const at of [[50, 60], [80, 60], [80, 70], [60, 70], [60, 90], [50, 90], [50, 60]] as [number, number][]) await sketchAt(page, 'click', at)
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Circle' }).click()
  await sketchAt(page, 'hover', [55, 65])
  await page.locator('body').press('5')
  const size = page.getByRole('group', { name: 'Exact size' })
  await size.getByLabel('X mm').fill('55')
  await size.getByLabel('Y mm').fill('65')
  await size.getByLabel('Y mm').press('Enter')
  const sizes = page.getByRole('group', { name: 'Sizes of the shape being drawn' })
  await sketchAt(page, 'hover', [56.5, 65])
  await page.locator('body').press('3')
  await sizes.getByLabel('Diameter mm').fill('3')
  await sizes.getByLabel('Diameter mm').press('Enter')
  await panel.locator('#sk-dist').fill('3')
  await panel.getByRole('button', { name: 'Extrude', exact: true }).click()
  await expect.poll(async () => (await read(page)).length).toBe(1)
  const bracket = (await read(page))[0]!
  await test.info().attach('initial-exact-bracket', { body: JSON.stringify(bracket), contentType: 'application/json' })
  expect(bracket.history?.exact).toBe(true)
  expect(bracket.closed).toBe(true)
  expect(bracket.size).toEqual([30, 30, 3])
  expect(Math.abs(bracket.volume - (500 - Math.PI * 2.25) * 3)).toBeLessThan(0.5)

  await command(page, 'Fit a hole for a screw or insert')
  await expect(panel).toContainText('No hole yet')
  await pick(page, await roundWall(page, bracket.id, [55, 65], 1.6))
  await expect(panel).toContainText('through')
  await panel.getByRole('combobox', { name: 'What the hole is for' }).selectOption('custom')
  await panel.locator('#hole-diameter').fill('4')
  await panel.getByRole('button', { name: 'Make hole', exact: true }).click()
  await expect.poll(async () => (await read(page))[0]!.history?.steps.length).toBe(2)

  await bedSketch(page)
  await panel.getByRole('radiogroup', { name: 'Drawing tool' }).getByRole('radio', { name: 'Rectangle' }).click()
  await sketchAt(page, 'click', [100, 60])
  await sketchAt(page, 'click', [106, 68])
  await panel.locator('#sk-dist').fill('4')
  await panel.getByRole('button', { name: 'Extrude', exact: true }).click()
  await expect.poll(async () => (await read(page)).length).toBe(2)
  await select(page, bracket.id)
  await command(page, 'Cut the selected object with a plane')
  const cut = page.locator('[data-section="cut-tool"]')
  await expect(cut).toContainText('remain editable')
  await cut.locator('#cut-offset').fill('0.5')
  await cut.locator('#cut-offset').press('Enter')
  const lower = cut.getByRole('radio', { name: 'Lower', exact: true })
  if (await lower.isVisible()) await lower.click()
  else await cut.getByRole('combobox', { name: 'Keep' }).selectOption('below')
  await cut.getByRole('button', { name: 'Cut', exact: true }).click()
  await expect.poll(async () => (await read(page)).find(b => b.id === bracket.id)?.size[2]).toBe(2)
  await tab(page, 'model').click({ timeout: 10000 })
  await page.getByRole('button', { name: /^Edit Hole 4 mm/ }).click()
  await panel.locator('#hole-diameter').fill('6')
  await panel.getByRole('button', { name: 'Make hole', exact: true }).click()
  const verify = async (diameter: number) => {
    const bodies = await read(page)
    const b = bodies.find(b => b.size[0] === 30)!
    expect(b.history?.exact).toBe(true)
    expect(b.closed).toBe(true)
    expect(b.size).toEqual([30, 30, 2])
    expect(Math.abs(b.volume - (500 - Math.PI * (diameter / 2) ** 2) * 2)).toBeLessThan(0.5)
    expect(b.history?.steps).toHaveLength(3)
    expect(b.history?.steps.every(s => !s.broken && !/mesh/i.test(s.note ?? ''))).toBe(true)
    const other = bodies.find(other => other.id !== b.id)!
    expect(other.size).toEqual([6, 8, 4])
    expect(other.volume).toBeCloseTo(192, 3)
  }
  await expect(() => verify(6)).toPass({ timeout: 30000 })
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await verify(4)
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  await verify(6)
  await tab(page, 'prepare').click()
  await addMenu(page, 'Export')
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /Save project/ }).click()])
  const bytes = [...readFileSync(await download.path())], name = download.suggestedFilename()
  await page.reload()
  await plateReady(page)
  await clear(page)
  await page.evaluate(({ bytes, name }) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array(bytes)], name))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, { bytes, name })
  await page.getByRole('button', { name: /^(Discard|Don't save|Open without saving)/ }).click({ timeout: 3000 }).catch(() => undefined)
  await expect(async () => { expect(await read(page)).toHaveLength(2); await verify(6) }).toPass({ timeout: 30000 })
  const reopened = (await read(page)).find(b => b.size[0] === 30)!
  await select(page, reopened.id)
  await command(page, 'Fit a hole for a screw or insert')
  await expect(panel).toContainText('No hole yet')
  await pick(page, await roundWall(page, reopened.id, [reopened.min[0]! + 5, reopened.min[1]! + 5], 3.1))
  await expect(panel).toContainText('6 mm')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Edit Hole 6 mm', exact: true }).click()
  await panel.locator('#hole-diameter').fill('5')
  await panel.getByRole('button', { name: 'Make hole', exact: true }).click()
  await expect(() => verify(5)).toPass({ timeout: 30000 })
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await verify(6)
  await tab(page, 'prepare').click()
  const beforeSlice = await sliceCount(page)
  await command(page, 'Slice the plate')
  await expect(sliced(page, beforeSlice)).toBeVisible({ timeout: 60000 })
  const paths = await page.evaluate(({ center, offsets, stride, outerWall }) => {
    const preview = (window as unknown as { __sx: { getState(): { preview: PreviewBuffers | null } } }).__sx.getState().preview
    if (!preview) throw new Error('The completed slice has no preview paths')
    const view = new DataView(preview.raw, preview.segmentsOffset, preview.segmentCount * stride)
    let clearance = Infinity, ringSegments = 0, quadrants = 0
    for (let i = 0; i < preview.segmentCount; i++) {
      const at = i * stride
      const z = view.getFloat32(at + offsets.z, true)
      // inspect interior layers, away from first-layer expansion and top surfaces
      if (z < 0.5 || z > 1.5) continue
      const x = view.getFloat32(at + offsets.x0, true) - center[0]!
      const y = view.getFloat32(at + offsets.y0, true) - center[1]!
      const dx = view.getFloat32(at + offsets.x1, true) - center[0]! - x
      const dy = view.getFloat32(at + offsets.y1, true) - center[1]! - y
      const length2 = dx * dx + dy * dy
      if (length2 === 0) continue
      const t = Math.max(0, Math.min(1, -(x * dx + y * dy) / length2))
      const distance = Math.hypot(x + t * dx, y + t * dy)
      const halfWidth = view.getUint16(at + offsets.widthUm, true) / 2000
      clearance = Math.min(clearance, distance - halfWidth)
      if (view.getUint8(at + offsets.feature) === outerWall && distance < 3.8) {
        ringSegments++
        quadrants |= 1 << ((x + dx / 2 >= 0 ? 1 : 0) + (y + dy / 2 >= 0 ? 2 : 0))
      }
    }
    return { clearance, ringSegments, quadrants }
  }, { center: [reopened.min[0]! + 5, reopened.min[1]! + 5], offsets: SXPV_SEGMENT, stride: SXPV_SEGMENT_BYTES, outerWall: FEATURE.outerWall })
  await test.info().attach('resliced-hole-paths', { body: JSON.stringify(paths), contentType: 'application/json' })
  // bead edges must leave the 6 mm opening; all four quadrants need an actual wall
  expect(paths.clearance).toBeGreaterThan(2.8)
  expect(paths.clearance).toBeLessThan(3.2)
  expect(paths.ringSegments).toBeGreaterThan(8)
  expect(paths.quadrants).toBe(15)
  expect(fallbacks).toEqual([])
})
