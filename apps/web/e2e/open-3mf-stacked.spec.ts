// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plain 3MF whose objects are stacked parts of one model (the two color X mark: its bands are separate objects at
// their own heights) opens with every object at the height the file gives it, the stack set down as a whole.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { type FileChooser } from '@playwright/test'
import { expect, plateReady, test, viewportReady } from './fixtures'

const FILE = join(import.meta.dirname, '..', '..', '..', 'packages/core/bench/models/x-mark-2color.3mf')

/** The lowest vertex Z of each object in the file's model, by object name. */
function fileHeights(bytes: Buffer): Map<string, number> {
  let model = ''
  for (let at = 0; bytes.readUInt32LE(at) === 0x04034b50; ) {
    const method = bytes.readUInt16LE(at + 8)
    const size = bytes.readUInt32LE(at + 18)
    const nameLen = bytes.readUInt16LE(at + 26)
    const start = at + 30 + nameLen + bytes.readUInt16LE(at + 28)
    const raw = bytes.subarray(start, start + size)
    if (bytes.subarray(at + 30, at + 30 + nameLen).toString() === '3D/3dmodel.model') model = (method === 8 ? inflateRawSync(raw) : raw).toString()
    at = start + size
  }
  const out = new Map<string, number>()
  for (const m of model.matchAll(/<object [^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    out.set(m[1]!, Math.min(...[...m[2]!.matchAll(/ z="([-0-9.e]+)"/g)].map((z) => Number(z[1]))))
  }
  return out
}

type Sx = { getState(): { plateLoading: boolean; plate: { name: string; parts: { positions: ArrayLike<number> }[]; transform: number[] }[] } }

test('a 3MF with stacked objects keeps each object at its height from the file', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop open')
  const bytes = readFileSync(FILE)
  const want = fileHeights(bytes)
  expect(want.size).toBe(2)
  const lowest = Math.min(...want.values())
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
  await seen[0]!.setFiles({ name: 'x-mark-2color.3mf', mimeType: 'model/3mf', buffer: bytes })
  const heights = () =>
    page.evaluate(() => {
      const st = (window as unknown as { __sx: Sx }).__sx.getState()
      if (st.plateLoading) return null
      return st.plate.map((e) => {
        let lo = Infinity
        for (const p of e.parts) for (let k = 0; k + 2 < p.positions.length; k += 3) {
          lo = Math.min(lo, e.transform[2]! * p.positions[k]! + e.transform[6]! * p.positions[k + 1]! + e.transform[10]! * p.positions[k + 2]! + e.transform[14]!)
        }
        return [e.name, lo] as [string, number]
      })
    })
  await expect.poll(async () => (await heights())?.length ?? 0, { timeout: 60_000 }).toBe(2)
  const got = new Map((await heights())!)
  // each object sits where the file puts it, relative to the stack's foot, and the stack rests on the bed
  for (const [name, z] of want) expect(got.get(name), name).toBeCloseTo(z - lowest, 2)
  expect(Math.min(...got.values())).toBeCloseTo(0, 2)
})
