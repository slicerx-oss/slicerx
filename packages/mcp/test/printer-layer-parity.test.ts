// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer's machine and filament through the server are the ones the app gives the same printer (stockLayer):
// `machine:<id>` is the maker's machine where there is one, and a slice that names no filament gets the printer's
// default filament. The Snapmaker U1 lost its own accelerations and retraction, and every printer printed the schema's
// filament (200 degrees, 2 mm3/s) instead of its maker's default.
import { describe, expect, it } from 'vitest'
import { goalEasy, layerConfig, listPrinterProfiles, stockLayer } from '@slicerx/settings'
import { resolveSliceConfig } from '../src/config'
import { connect } from './helpers'

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

describe("a printer's machine and filament through the server", () => {
  it("gives the U1 its maker's machine and default filament", async () => {
    const h = await connect()
    await h.ctx.profiles.prepare(['machine:snapmaker-u1'])
    const { config, applied } = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:snapmaker-u1'], undefined)
    expect(config.machine_max_acceleration_x).toEqual(Array(8).fill(25000))
    expect(config.retraction_length).toEqual([0.8, 0.8, 0.8, 0.8])
    expect(config.nozzle_type).toEqual(['stainless_steel,stainless_steel,stainless_steel,stainless_steel'])
    expect(config.filament_vendor).toEqual(['Snapmaker'])
    expect(config.nozzle_temperature).toEqual([210])
    expect(config.filament_max_volumetric_speed).toEqual([14])
    expect(applied.some((a) => a.startsWith('default filament: '))).toBe(true)
  })

  it('keeps a named filament, and the schema filament without a printer', async () => {
    const h = await connect()
    await h.ctx.profiles.prepare(['machine:snapmaker-u1', 'filament:petg'])
    const named = resolveSliceConfig(h.ctx.store, h.ctx.profiles, ['machine:snapmaker-u1', 'filament:petg'], undefined)
    expect(named.applied.some((a) => a.startsWith('default filament: '))).toBe(false)
    const none = resolveSliceConfig(h.ctx.store, h.ctx.profiles, [], undefined)
    expect(none.applied).toEqual(['process:slicerx-default'])
  })

  it("matches the app's whole layer on every printer, for the default process and for Standard", async () => {
    const h = await connect()
    const printers = listPrinterProfiles()
    await h.ctx.profiles.prepare([...printers.map((p) => `machine:${p.id}`), 'process:standard'])
    const differ: string[] = []
    for (const p of printers) {
      const layer = await stockLayer({ printerId: p.id, tier: 'standard', slots: [] })
      if (!layer) continue
      const app = layerConfig(layer.values, goalEasy('standard'), new Set(['smartLayer', 'varyLayerHeight']))
      for (const names of [[`machine:${p.id}`], [`machine:${p.id}`, 'process:standard']]) {
        const mcp = resolveSliceConfig(h.ctx.store, h.ctx.profiles, names, undefined).config as Record<string, unknown>
        for (const k of new Set([...Object.keys(app), ...Object.keys(mcp)])) {
          if (!same(app[k], mcp[k])) differ.push(`${names.join(',')} ${k}: app ${JSON.stringify(app[k])}, server ${JSON.stringify(mcp[k])}`)
        }
      }
    }
    expect(differ.length, differ.slice(0, 20).join('\n')).toBe(0)
  }, 300_000)
})
