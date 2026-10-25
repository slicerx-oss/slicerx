// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project opened by a printer's name prints with the G-code SlicerX ships for that printer, the text
// machine:<id> gives and the app prints with: its start script, and its filament change, which lifts over everything
// printed so far. Without them sx printed a bare tool change at the layer's height, and on a plate printed by object
// the check found the head's trip to the purge spot crossing the finished parts.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SettingValue } from '@slicerx/contracts'
import { boxStl, connect, data, noSx, sxBin, type Harness } from './helpers'

type Res<T> = { ok: boolean; summary: string; output: T; error?: { code: string; message: string } }

async function call<T = Record<string, unknown>>(h: Harness, name: string, args: Record<string, unknown> = {}): Promise<Res<T>> {
  const r = await h.call(name, args)
  const d = data<Partial<Res<T>>>(r)
  const out = { ...d, ok: d.ok ?? !r.isError } as Res<T>
  expect(out.ok, `${name}: ${out.error?.message ?? out.summary}`).toBe(true)
  return out
}

/** Every request.json the slices of a harness wrote. */
function requests(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? requests(p) : f === 'request.json' ? [p] : []
  })
}

describe.skipIf(noSx())('a project opened by printer name, sliced with sx', () => {
  it.each([
    ['Bambu Lab A1', 'machine:bambu-a1'],
    ['Bambu Lab P1S', 'machine:bambu-p1s'],
  ])('sends sx the start and filament change G-code SlicerX ships for the %s', async (printer, machine) => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      writeFileSync(join(h.dir, 'part.stl'), boxStl(12, 12, 5))
      await call(h, 'slicerx_project_open', { printer, filament: 'Bambu PLA Basic' })
      await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'part.stl') })
      await call(h, 'slicerx_slice')
      const sent = requests(h.dir)
      expect(sent.length).toBeGreaterThan(0)
      const req = JSON.parse(readFileSync(sent[0]!, 'utf8')) as { config: Record<string, SettingValue>; options: { trustedGcode?: boolean } }
      const shipped = data<{ config: Record<string, SettingValue> }>(await h.call('slicerx_get_profile', { profile: machine })).config
      for (const key of ['machine_start_gcode', 'change_filament_gcode']) {
        expect(String(shipped[key] ?? '').length, `${machine} ships ${key}`).toBeGreaterThan(0)
        expect(req.config[key], key).toEqual(shipped[key])
      }
      // the shipped text, so sx runs it as trusted G-code
      expect(req.options.trustedGcode).toBe(true)
    } finally {
      await h.client.close()
    }
  }, 240_000)

  it('slices the fullest A1 plate printed by object whose sparse infill is in filament 2, the filament change lifting over the finished parts', async () => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      writeFileSync(join(h.dir, 'part.stl'), boxStl(12, 12, 5))
      await call(h, 'slicerx_project_open', { printer: 'Bambu Lab A1', filament: 'Bambu PLA Basic' })
      await call(h, 'slicerx_project_add_model', { model: join(h.dir, 'part.stl') })
      await call(h, 'slicerx_project_add_filament', { type: 'PLA', color: '#2255FF' })
      // every layer of every cube changes filament twice
      await call(h, 'slicerx_project_set_overrides', { changes: { print_sequence: 'by object', brim_type: 'no_brim', skirt_loops: 0, sparse_infill_filament_id: 2 } })
      const fit = String(data<{ error?: { message: string } }>(await h.call('slicerx_arrange', { count: 40 })).error?.message).match(/Only (\d+) of 40 fit/)
      expect(fit).not.toBeNull()
      await call(h, 'slicerx_arrange', { count: Number(fit![1]) })
      // with a bare tool change at the layer's height, sx refused this plate: the trip to the purge spot crossed a
      // finished cube
      const sliced = await call<{ total: { grams: number } }>(h, 'slicerx_slice')
      expect(sliced.output.total.grams).toBeGreaterThan(0)
    } finally {
      await h.client.close()
    }
  }, 240_000)
})
