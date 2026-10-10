// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plain 3MF whose objects are stacked parts of one model (the two color X mark: its bands are separate objects at
// their own heights) opens with every object at the height the file gives it, the stack set down as a whole. Objects
// that touch open as one object with those parts, as Bambu Studio offers; the open note can keep them separate.
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

type Sx = { getState(): { plateLoading: boolean; plate: { name: string; parts: { name: string; slot: number; positions: ArrayLike<number> }[]; transform: number[] }[] } }

test('a 3MF with stacked objects keeps each at its height from the file, joined as one object with parts unless kept separate', async ({ page, isMobile }) => {
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
  // The objects on the plate, each with the world height of its parts' feet and their filaments.
  const plate = () =>
    page.evaluate(() => {
      const st = (window as unknown as { __sx: Sx }).__sx.getState()
      if (st.plateLoading) return null
      return st.plate.map((e) => ({
        name: e.name,
        parts: e.parts.map((p) => {
          let lo = Infinity
          for (let k = 0; k + 2 < p.positions.length; k += 3) lo = Math.min(lo, e.transform[2]! * p.positions[k]! + e.transform[6]! * p.positions[k + 1]! + e.transform[10]! * p.positions[k + 2]! + e.transform[14]!)
          return { name: p.name, slot: p.slot, z: lo }
        }),
      }))
    })
  const heights = (objects: NonNullable<Awaited<ReturnType<typeof plate>>>) => new Map(objects.flatMap((o) => o.parts.map((p) => [p.name, p.z] as [string, number])))

  // Opened as one object with the two bands as parts, each band where the file puts it and on its own filament.
  await expect.poll(async () => (await plate())?.map((o) => o.parts.length), { timeout: 60_000 }).toEqual([2])
  const joined = (await plate())!
  expect(joined[0]!.name).toBe('x-mark-2color')
  expect(joined[0]!.parts.map((p) => p.slot)).toEqual([1, 2])
  const got = heights(joined)
  for (const [name, z] of want) expect(got.get(name), name).toBeCloseTo(z - lowest, 2)
  expect(Math.min(...got.values())).toBeCloseTo(0, 2)

  // The open note offers to keep them separate: two objects again, at the same heights.
  // The note is a toast that closes after 8 s. A click waits for its enter animation to settle, and on a loaded
  // machine that can outlast the toast, so the button is pressed as soon as the note shows.
  const note = page.getByTestId('toast').filter({ hasText: /2 of its objects touch, so they were loaded as one object with parts/ })
  await expect(note).toBeVisible()
  const keep = note.getByRole('button', { name: 'Keep separate' })
  await expect(keep).toBeVisible()
  await keep.dispatchEvent('click')
  await expect.poll(async () => (await plate())?.map((o) => o.parts.length), { timeout: 30_000 }).toEqual([1, 1])
  const apart = heights((await plate())!)
  for (const [name, z] of want) expect(apart.get(name), name).toBeCloseTo(z - lowest, 2)
})
