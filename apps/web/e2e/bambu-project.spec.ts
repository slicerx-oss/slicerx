// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Studio project carries -1 where Bambu Studio picks the value itself (raft_first_layer_expansion,
// tree_support_wall_count). It opens and slices with the real engine, and a value the engine still refuses is dropped
// with a note instead of blocking the slice. The project is made here: a 20 mm cube and Bambu Studio's settings form.
import { deflateRawSync } from 'node:zlib'
import { expect, type Page } from '@playwright/test'
import { plateReady, test } from './fixtures'

const CUBE = (() => {
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  const vertices = v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')
  const triangles = t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" name="Cube" type="model"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 80 80 0"/></build></model>`
})()

/** Bambu Studio's -1s as it writes them (every value a string), with a raft and supports on so they are used. */
const BAMBU = {
  enable_support: '1',
  raft_layers: '2',
  raft_first_layer_expansion: '-1',
  tree_support_wall_count: '-1',
  support_interface_bottom_layers: '-1',
  prime_tower_brim_width: '-1',
  ironing_fan_speed: ['-1'],
  filament_ramming_volumetric_speed: ['-1'],
  filament_tower_interface_print_temp: ['-1'],
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (b: Buffer): number => {
  let c = 0xffffffff
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A deflated zip of `files`. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text)
    const packed = deflateRawSync(data)
    const n = Buffer.from(name)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(8, 8)
    head.writeUInt32LE(crc32(data), 14)
    head.writeUInt32LE(packed.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(n.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(head, n, packed)
    centrals.push(central, n)
    offset += head.length + n.length + packed.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('sx-e2e')) return
    sessionStorage.setItem('sx-e2e', '1')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', pilot: { mode: 'off' } }))
  })
  await page.goto('./')
  await plateReady(page)
}

/** Open (Mod+O) the project: a new project with the file, so its settings come along. */
async function openProject(page: Page, settings: Record<string, unknown>): Promise<void> {
  const buffer = zip({ '3D/3dmodel.model': CUBE, 'Metadata/project_settings.config': JSON.stringify(settings) })
  await expect(async () => {
    const chooser = page.waitForEvent('filechooser', { timeout: 5_000 })
    await page.keyboard.press('ControlOrMeta+o')
    await (await chooser).setFiles({ name: 'a1-mini.3mf', mimeType: 'model/3mf', buffer })
  }).toPass({ timeout: 60_000 })
  await expect(page.locator('.obj-name')).toHaveText(['Cube'], { timeout: 60_000 })
}

async function sliceToPreview(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(page.locator('.sx-tab[aria-current=page]')).toContainText('Preview', { timeout: 120_000 })
  await expect(page.getByText(/config key/)).toHaveCount(0)
}

test("a Bambu Studio project's -1 values open and slice with no error", async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  await openProject(page, BAMBU)
  await sliceToPreview(page)
})

test('a project value the engine refuses is dropped with a note, and the plate still slices', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Runs at desktop width')
  test.slow()
  await open(page)
  await openProject(page, { ...BAMBU, raft_expansion: '-3' })
  await page.getByRole('button', { name: 'Slice plate' }).click()
  await expect(page.getByText(/Setting not imported from a1-mini\.3mf: Raft expansion/)).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.sx-tab[aria-current=page]')).toContainText('Preview', { timeout: 120_000 })
  await expect(page.getByText(/config key/)).toHaveCount(0)
})
