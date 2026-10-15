// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { boxStl, connect, data, noSx, sxBin } from './helpers'

it.skipIf(noSx()).each([
  { name: 'skirt', changes: { skirt_loops: 1, skirt_distance: 6, brim_type: 'no_brim' }, refused: 45, accepted: 40 },
  { name: 'wide skirt', changes: { skirt_loops: 2, skirt_distance: 20, brim_type: 'no_brim' }, refused: 40, accepted: 24 },
  { name: 'shifted smaller bed skirt', changes: { skirt_loops: 1, skirt_distance: 6, brim_type: 'no_brim', printable_area: ['20x10', '220x10', '220x210', '20x210'] }, refused: 40, accepted: 20 },
  { name: 'brim', changes: { skirt_loops: 0, brim_type: 'outer_only', brim_width: 12 }, refused: 40, accepted: 12 },
])('keeps the $name inside the printable area', async ({ changes, refused: tooMany, accepted }) => {
  const h = await connect({ engine: 'sx', sxBin })
  try {
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await h.call(name, args)
      const d = data(r)
      expect(r.isError, JSON.stringify(d)).not.toBe(true)
      expect(d['ok'], JSON.stringify(d)).not.toBe(false)
      return d
    }
    await call('slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
    writeFileSync(join(h.dir, 'box.stl'), boxStl(40, 23, 15))
    await call('slicerx_project_add_model', { model: join(h.dir, 'box.stl') })
    await call('slicerx_project_set_overrides', { changes: { ...changes, layer_height: 0.3 } })
    const refused = await h.call('slicerx_arrange', { count: tooMany })
    expect(refused.isError).toBe(true)
    await call('slicerx_arrange', { count: accepted })
    await call('slicerx_slice')
  } finally {
    await h.client.close()
  }
}, 240_000)
