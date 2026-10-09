// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Opening one model the engine splits into loose bodies: the pieces keep the places they had as one model, so nothing
// on the plate moves after it first shows (no arrange, no second arrange), and the slice that follows starts after.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type FileChooser } from '@playwright/test'
import { expect, plateReady, test, viewportReady } from './fixtures'

/** A binary STL of two 20 mm cubes 30 mm apart: one file, two loose bodies. */
function twoCubes(): string {
  const tris: number[][] = []
  const cube = (ox: number) => {
    const v = (x: number, y: number, z: number) => [ox + x * 20, y * 20, z * 20]
    const quad = (a: number[], b: number[], c: number[], d: number[]) => tris.push([...a, ...b, ...c], [...a, ...c, ...d])
    quad(v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0))
    quad(v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1))
    quad(v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1))
    quad(v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0))
    quad(v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0))
    quad(v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1))
  }
  cube(0)
  cube(50)
  const buf = Buffer.alloc(84 + tris.length * 50)
  buf.writeUInt32LE(tris.length, 80)
  tris.forEach((t, i) => t.forEach((n, k) => buf.writeFloatLE(n, 84 + i * 50 + 12 + k * 4)))
  const file = join(mkdtempSync(join(tmpdir(), 'sx-split-')), 'two-cubes.stl')
  writeFileSync(file, buf)
  return file
}

type Sx = { getState(): { plateLoading: boolean; plate: { id: string; parts: { positions: ArrayLike<number> }[]; transform: number[] }[] } }

test('a model split into two bodies keeps its pieces in place: nothing moves after it first shows', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop open')
  const seen: FileChooser[] = []
  page.on('filechooser', (c) => seen.push(c))
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.debug', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  await viewportReady(page)
  for (let i = 0; i < 10 && seen.length === 0; i++) {
    await page.keyboard.press('ControlOrMeta+o')
    await page.waitForTimeout(500)
  }
  await seen[0]!.setFiles(twoCubes())
  // The world X spans of everything on the plate, sampled through the open until it is done.
  const samples: { loading: boolean; spans: [number, number][] }[] = []
  for (let i = 0; i < 300; i++) {
    const s = await page.evaluate(() => {
      const st = (window as unknown as { __sx: Sx }).__sx.getState()
      const spans = st.plate.map((e) => {
        let lo = Infinity
        let hi = -Infinity
        for (const p of e.parts) for (let k = 0; k + 2 < p.positions.length; k += 3) {
          const x = e.transform[0]! * p.positions[k]! + e.transform[4]! * p.positions[k + 1]! + e.transform[8]! * p.positions[k + 2]! + e.transform[12]!
          lo = Math.min(lo, x)
          hi = Math.max(hi, x)
        }
        return [Math.round(lo * 100) / 100, Math.round(hi * 100) / 100] as [number, number]
      })
      return { loading: st.plateLoading, spans: spans.sort((a, b) => a[0] - b[0]) }
    })
    if (s.spans.length) samples.push(s)
    if (!s.loading && s.spans.length === 2) break
    await page.waitForTimeout(100)
  }
  const last = samples.at(-1)!
  expect(last.spans).toHaveLength(2)
  // the pieces are 30 mm apart, as in the file
  expect(last.spans[1]![0] - last.spans[0]![1]).toBeCloseTo(30, 1)
  // from the first frame with the model to the end, the model's overall span never changes
  const outer = (sp: [number, number][]) => [Math.min(...sp.map((x) => x[0])), Math.max(...sp.map((x) => x[1]))]
  for (const s of samples) expect(outer(s.spans)).toEqual(outer(last.spans))
})
