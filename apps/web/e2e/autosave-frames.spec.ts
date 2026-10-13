// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The autosave writes a big project without stopping the page: the viewport keeps drawing while it runs. Written on
// the page, a plate of 3.4 million triangles held it for about 5 s. The plate here is made in the spec: a closed
// heightfield of about a million triangles, a tenth of them painted as support enforcers.
import { type Page } from '@playwright/test'
import { GL_SLOW } from './frames'
import { expectFileDialog, interceptFileDialogs } from './file-dialog'
import { expect, plateReady, test } from './fixtures'
import { zip } from './project-zip'

/** A closed heightfield `n` cells on a side, 120 mm square: top and bottom grids joined by four walls. */
function terrain(n: number): { model: string; triangles: number } {
  const size = 120
  const step = size / n
  const row = n + 1
  const verts: string[] = []
  for (const top of [true, false]) {
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const z = top ? 6 + 2 * Math.sin(i / 9) * Math.cos(j / 7) : 0
        verts.push(`<vertex x="${(i * step).toFixed(3)}" y="${(j * step).toFixed(3)}" z="${z.toFixed(3)}"/>`)
      }
    }
  }
  const below = row * row
  const tris: string[] = []
  const tri = (a: number, b: number, c: number): void => {
    // Every tenth triangle is painted as a support enforcer, the way Bambu Studio writes one.
    tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"${tris.length % 10 === 0 ? ' paint_supports="4"' : ''}/>`)
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * row + i
      tri(a, a + 1, a + row + 1)
      tri(a, a + row + 1, a + row)
      tri(below + a, below + a + row + 1, below + a + 1)
      tri(below + a, below + a + row, below + a + row + 1)
    }
  }
  // The walls, each edge of the top grid down to the same edge of the bottom one, facing out.
  const wall = (p: number, q: number): void => {
    tri(p, below + p, below + q)
    tri(p, below + q, q)
  }
  for (let i = 0; i < n; i++) {
    wall(i + 1, i)
    wall(n * row + i, n * row + i + 1)
    wall(i * row, (i + 1) * row)
    wall((i + 1) * row + n, i * row + n)
  }
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" name="Terrain" type="model"><mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 60 60 0"/></build></model>`
  return { model, triangles: tris.length }
}

interface Sx {
  getState(): { plate: { name: string }[]; plates: { objects: { name: string }[] }[]; plateLoading: boolean; overrides: Record<string, unknown> }
  setState(fn: (s: { overrides: Record<string, unknown> }) => object): void
}

async function openTerrain(page: Page): Promise<number> {
  const { model, triangles } = terrain(500)
  const buffer = zip({ '3D/3dmodel.model': model })
  const chooser = await expectFileDialog(page, () => page.keyboard.press('ControlOrMeta+o'))
  await chooser.setFiles({ name: 'terrain.3mf', mimeType: 'model/3mf', buffer })
  await expect(page.locator('.obj-name')).toHaveText(['Terrain'], { timeout: 120_000 })
  return triangles
}

test('the viewport keeps drawing while a big project autosaves', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Storage and timing, not layout')
  test.slow()
  interceptFileDialogs(page)
  await page.addInitScript(() => {
    localStorage.setItem('slicerx.debug', '1')
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
  expect(await openTerrain(page)).toBeGreaterThan(1_000_000)
  await page.waitForFunction(() => !(window as unknown as { __sx: Sx }).__sx.getState().plateLoading, null, { timeout: 120_000 })
  // The open's own work (meshes to the engine and the viewport) settles first.
  await page.waitForTimeout(3000)
  const run = await page.evaluate(async () => {
    const hasAutosave = () =>
      new Promise<boolean>((resolve, reject) => {
        const req = indexedDB.open('slicerx-projects', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('snapshots', { keyPath: 'id' })
        req.onsuccess = () => {
          const keys = req.result.transaction('snapshots').objectStore('snapshots').getAllKeys()
          keys.onsuccess = () => {
            req.result.close()
            resolve((keys.result as string[]).includes('autosave'))
          }
          keys.onerror = () => reject(keys.error)
        }
        req.onerror = () => reject(req.error)
      })
    const frames: number[] = []
    let live = true
    const tick = (t: number): void => {
      frames.push(t)
      if (live) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    // An edit the autosave writes a few seconds later. Auto slice is off, so nothing else runs meanwhile.
    const t0 = performance.now()
    ;(window as unknown as { __sx: Sx }).__sx.setState((s) => ({ overrides: { ...s.overrides, wall_loops: '3' } }))
    let saved = 0
    while (performance.now() - t0 < 90_000 && !saved) {
      await new Promise((r) => setTimeout(r, 100))
      if (await hasAutosave()) saved = performance.now()
    }
    live = false
    let gap = 0
    for (let i = 1; i < frames.length; i++) gap = Math.max(gap, frames[i]! - frames[i - 1]!)
    return { savedAfterMs: saved ? saved - t0 : null, frames: frames.length, longestGapMs: Math.round(gap) }
  })
  console.log(`autosave of the terrain: ${JSON.stringify(run)}`)
  expect(run.savedAfterMs).not.toBeNull()
  // Written on the page, the file held it for over a second here; in the worker no frame waits more than a moment.
  expect(run.longestGapMs).toBeLessThan(400 * GL_SLOW)
  expect(run.frames).toBeGreaterThan(run.savedAfterMs! / 1000 * 10)
})
