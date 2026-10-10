// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Shared steps for the modeling tool specs. A click on the model is sent as the same pick event the
// viewport sends for it (found on the object's own mesh here), so the tools get exact faces and edges
// whatever the camera shows. Everything after the pick goes through the tool panels.
import { type Page } from '@playwright/test'
import { expect, openTransform, plateReady } from './fixtures'

export type V3 = [number, number, number]

export interface Box {
  min: V3
  max: V3
  triangles: number
}

export interface StepInfo {
  name: string
  state: string
}

/** Opens the studio on the plate tab, on the reference plate, with debug hooks and mimir off. */
export async function openStudio(page: Page, prefs: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((prefs) => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' }, ...prefs }))
  }, prefs)
  await page.goto('./')
  await plateReady(page)
}

/** Runs a command from Cmd+K by its title. */
export async function command(page: Page, title: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible()
  await page.keyboard.type(title)
  await page.locator('.sx-palette-item', { hasText: title }).first().click()
}

/** Empties the plate, then adds a 20 mm box through Cmd+K. Returns its id. */
export async function freshBox(page: Page): Promise<string> {
  await page.evaluate(() => (window as unknown as { __sx: { setState(p: unknown): void } }).__sx.setState({ plate: [], selection: null, selectedIds: [] }))
  await command(page, 'Add a box')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: unknown[] } } }).__sx.getState().plate.length)).toBe(1)
  return page.evaluate(() => (window as unknown as { __sx: { getState(): { plate: { id: string }[] } } }).__sx.getState().plate[0]!.id)
}

/** The object's bounds on the bed (mm) and its triangle count. */
export function bounds(page: Page, objectId: string): Promise<Box> {
  return page.evaluate((id) => {
    type E = { id: string; transform: number[]; parts: { positions: Float32Array; indices: Uint32Array }[] }
    const e = (window as unknown as { __sx: { getState(): { plate: E[] } } }).__sx.getState().plate.find((p) => p.id === id)
    if (!e) throw new Error(`no object ${id}`)
    const m = e.transform
    const min: [number, number, number] = [Infinity, Infinity, Infinity]
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
    let triangles = 0
    for (const part of e.parts) {
      triangles += part.indices.length / 3
      const p = part.positions
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!
        const w = [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!]
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, w[k]!)
          max[k] = Math.max(max[k]!, w[k]!)
        }
      }
    }
    return { min, max, triangles }
  }, objectId)
}

export async function height(page: Page, objectId: string): Promise<number> {
  const b = await bounds(page, objectId)
  return Math.round((b.max[2] - b.min[2]) * 100) / 100
}

/**
 * The outermost flat triangle facing `dir` on the object, as a pick: its triangle index, part and a
 * point on it. With `near`, the triangle of that face that holds the point nearest `near` instead.
 */
export function facePick(page: Page, objectId: string, dir: V3, near?: V3): Promise<{ objectId: string; partIndex: number; triangle: number; point: V3 }> {
  return page.evaluate(
    ({ id, dir, near }) => {
      type E = { id: string; transform: number[]; parts: { positions: Float32Array; indices: Uint32Array }[] }
      const e = (window as unknown as { __sx: { getState(): { plate: E[] } } }).__sx.getState().plate.find((p) => p.id === id)
      if (!e) throw new Error(`no object ${id}`)
      const m = e.transform
      const world = (p: Float32Array, i: number): number[] => {
        const x = p[i * 3]!, y = p[i * 3 + 1]!, z = p[i * 3 + 2]!
        return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!]
      }
      const sub = (a: number[], b: number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]
      const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
      const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]
      type Hit = { partIndex: number; triangle: number; point: number[]; key: number }
      const hits: Hit[] = []
      e.parts.forEach((part, partIndex) => {
        for (let t = 0; t < part.indices.length / 3; t++) {
          const a = world(part.positions, part.indices[t * 3]!), b = world(part.positions, part.indices[t * 3 + 1]!), c = world(part.positions, part.indices[t * 3 + 2]!)
          const n = cross(sub(b, a), sub(c, a))
          const len = Math.hypot(n[0]!, n[1]!, n[2]!)
          if (len < 1e-9 || dot(n, dir) / len < 0.9999) continue
          let point = [(a[0]! + b[0]! + c[0]!) / 3, (a[1]! + b[1]! + c[1]!) / 3, (a[2]! + b[2]! + c[2]!) / 3]
          if (near) {
            // The point of this triangle nearest `near`: barycentric clamp by sampling is enough for a pick.
            let best = point, bd = Infinity
            for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20 - i; j++) {
              const u = i / 20, v = j / 20, w = 1 - u - v
              const q = [a[0]! * w + b[0]! * u + c[0]! * v, a[1]! * w + b[1]! * u + c[1]! * v, a[2]! * w + b[2]! * u + c[2]! * v]
              const d = Math.hypot(q[0]! - near[0], q[1]! - near[1], q[2]! - near[2])
              if (d < bd) { bd = d; best = q }
            }
            hits.push({ partIndex, triangle: t, point: best, key: -bd + dot(best, dir) * 1e-6 })
          } else hits.push({ partIndex, triangle: t, point, key: dot(point, dir) })
        }
      })
      hits.sort((x, y) => y.key - x.key)
      const h = hits[0]
      if (!h) throw new Error('no face faces that way')
      return { objectId: id, partIndex: h.partIndex, triangle: h.triangle, point: h.point as [number, number, number] }
    },
    { id: objectId, dir, near: near ?? null },
  )
}

/** Sends the view's pick event, as a click on that spot does. */
export async function pick(page: Page, hit: { objectId: string | null; partIndex: number | null; triangle: number | null; point: V3 | null; bed?: [number, number] | null; shift?: boolean }): Promise<void> {
  await page.evaluate((h) => {
    const vp = (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp
    vp.emit('pick', { bed: h.point ? [h.point[0], h.point[1]] : null, ...h })
  }, hit)
}

/** Sends a sketch event from the view: a hover or a click at a point on the sketch plane. */
export async function sketchAt(page: Page, kind: 'hover' | 'click', at: [number, number]): Promise<void> {
  await page.evaluate(({ kind, at }) => {
    const vp = (window as unknown as { __vp: { emit(e: string, p: unknown): void } }).__vp
    vp.emit('sketch', { kind, at, mmPerPx: 0.2, screen: [700, 420], shift: false, alt: false })
  }, { kind, at })
}

/** Clicks an action on a history step: a button on Slice's history list, or an item in the step's More menu in Model's tree, opened as a person would. */
export async function clickStepButton(page: Page, step: string, name: string): Promise<void> {
  const row = page.locator('.cad-step').filter({ has: page.locator('.cad-step-name', { hasText: step }) }).first()
  await row.hover()
  const direct = row.getByRole('button', { name })
  if (await direct.count()) return direct.click()
  // Model's tree: the step's menu, from its More button. Delete there asks first.
  await row.getByTestId('model-tree-more').click()
  const menu = page.getByTestId('model-ctx')
  if (/^Delete /.test(name)) {
    await menu.getByTestId('danger-model-ctx-delete').click()
    await page.getByTestId('danger-model-confirm-delete').click()
  } else if (/^Suppress |^Turn .* back on$/.test(name)) await menu.getByTestId('model-ctx-suppress').click()
  else if (/^Move .* earlier$/.test(name)) await menu.getByTestId('model-ctx-earlier').click()
  else if (/^Move .* later$/.test(name)) await menu.getByTestId('model-ctx-later').click()
  else throw new Error(`No step action named ${name}`)
}

/** The history panel's steps, by name and state. */
export function steps(page: Page): Promise<StepInfo[]> {
  return page.locator('.cad-history .cad-step, .dtree .cad-step').evaluateAll((rows) =>
    rows.map((r) => ({ name: (r.querySelector('.cad-step-name')?.textContent ?? '').trim(), state: r.getAttribute('data-state') ?? '' })),
  )
}

/** The panel of the open modeling tool. */
export const toolPanel = (page: Page) => page.locator('[data-section="cad-tool"]')

/** Picks the top face with the push and pull tool and moves it by `mm`, a number or a sum of named values. */
export async function pushTop(page: Page, objectId: string, mm: number | string): Promise<void> {
  await command(page, 'Push or pull a face')
  const panel = toolPanel(page)
  await expect(panel).toContainText('No face yet')
  await pick(page, await facePick(page, objectId, [0, 0, 1]))
  await expect(panel).toContainText('A face is picked')
  await panel.locator('#push-dist').fill(String(mm))
  await panel.getByRole('button', { name: String(mm).startsWith('-') ? 'Push in' : 'Pull out' }).click()
  // Apply runs the push and closes the tool.
  await expect(panel).toHaveCount(0, { timeout: 30_000 })
}

/** Moves the selected object to a spot on the bed with the Position fields (in Slice, in the Transform popover). */
export async function placeAt(page: Page, x: number, y: number): Promise<void> {
  const pos = page.getByRole('group', { name: 'Position' })
  const popover = !(await pos.isVisible())
  if (popover) await openTransform(page)
  for (const [axis, v] of [[/X/, x], [/Y/, y]] as const) {
    const field = pos.getByRole('textbox', { name: axis })
    await field.fill(String(v))
    await field.press('Enter')
    await field.blur()
  }
  if (popover) {
    await page.keyboard.press('Escape')
    await expect(page.locator('.selbar-transform')).toHaveCount(0)
  }
}

type PlateEntry = { id: string; transform: number[]; parts: { positions: Float32Array; indices: Uint32Array }[] }

/** A triangle of a round hole's wall or a rod's side around the vertical axis through `c`: upright, its middle
 * within `r` of the axis. */
export function roundWall(page: Page, objectId: string, c: [number, number], r: number): Promise<{ objectId: string; partIndex: number; triangle: number; point: V3 }> {
  return page.evaluate(({ id, c, r }) => {
    const e = (window as unknown as { __sx: { getState(): { plate: PlateEntry[] } } }).__sx.getState().plate.find((p) => p.id === id)!
    const m = e.transform
    const p = e.parts[0]!.positions
    const w = (i: number) => [0, 1, 2].map((k) => m[k]! * p[i * 3]! + m[4 + k]! * p[i * 3 + 1]! + m[8 + k]! * p[i * 3 + 2]! + m[12 + k]!)
    const ix = e.parts[0]!.indices
    for (let t = 0; t < ix.length / 3; t++) {
      const [a, b, d] = [w(ix[t * 3]!), w(ix[t * 3 + 1]!), w(ix[t * 3 + 2]!)]
      const n = [(b[1]! - a[1]!) * (d[2]! - a[2]!) - (b[2]! - a[2]!) * (d[1]! - a[1]!), (b[2]! - a[2]!) * (d[0]! - a[0]!) - (b[0]! - a[0]!) * (d[2]! - a[2]!), (b[0]! - a[0]!) * (d[1]! - a[1]!) - (b[1]! - a[1]!) * (d[0]! - a[0]!)]
      const mid = [0, 1, 2].map((k) => (a[k]! + b[k]! + d[k]!) / 3)
      if (Math.abs(n[2]!) < 1e-6 * Math.hypot(n[0]!, n[1]!, n[2]!) && Math.hypot(mid[0]! - c[0], mid[1]! - c[1]) < r) return { objectId: id, partIndex: 0, triangle: t, point: mid as V3 }
    }
    throw new Error('no wall')
  }, { id: objectId, c, r })
}

/** How many vertices of the object sit at height `z` with their distance from the vertical axis through `c` in
 * `range`. */
export function pointsAround(page: Page, objectId: string, c: [number, number], z: number, range: [number, number]): Promise<number> {
  return page.evaluate(({ id, c, z, range }) => {
    const e = (window as unknown as { __sx: { getState(): { plate: PlateEntry[] } } }).__sx.getState().plate.find((p) => p.id === id)!
    const m = e.transform
    let n = 0
    for (const part of e.parts) {
      const p = part.positions
      for (let i = 0; i < p.length; i += 3) {
        const x = m[0]! * p[i]! + m[4]! * p[i + 1]! + m[8]! * p[i + 2]! + m[12]!
        const y = m[1]! * p[i]! + m[5]! * p[i + 1]! + m[9]! * p[i + 2]! + m[13]!
        const h = m[2]! * p[i]! + m[6]! * p[i + 1]! + m[10]! * p[i + 2]! + m[14]!
        const r = Math.hypot(x - c[0], y - c[1])
        if (Math.abs(h - z) < 0.01 && r > range[0] && r < range[1]) n++
      }
    }
    return n
  }, { id: objectId, c, z, range })
}
