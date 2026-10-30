// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer's process through the server is the one the app gives the same printer: the maker's own preset for the
// tier where there is one (stockLayer), not SlicerX's generic tier. The Snapmaker U1's Standard turns ooze prevention
// on with its idle tools 150 degrees cooler; a slice of `machine:snapmaker-u1` lost that.
import { describe, expect, it } from 'vitest'
import { goalEasy, layerConfig, listPrinterProfiles, stockLayer } from '@slicerx/settings'
import { sectionOf } from '@slicerx/settings/defaults'
import { resolveSliceConfig } from '../src/config'
import { connect } from './helpers'

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// The sleipnir bounds: the app works them out from the printer's own thickest layer (the Easy rule over the whole
// layer), the server from the generic machine's when it builds the tier. They differ on a few printers (the K1C and
// the Ultimakers) and are left to a change of their own.
const MACHINE_FOLLOWING = new Set(['smart_layer_min_height', 'smart_layer_max_height'])

describe("a printer's process through the server", () => {
  it("keeps the U1 Standard preset's ooze prevention, named or by default", async () => {
    const h = await connect()
    await h.ctx.profiles.prepare(['machine:snapmaker-u1', 'process:standard'])
    for (const names of [['machine:snapmaker-u1', 'process:standard'], ['process:standard', 'machine:snapmaker-u1'], ['machine:snapmaker-u1']]) {
      const { config } = resolveSliceConfig(h.ctx.store, h.ctx.profiles, names, undefined)
      expect(config.ooze_prevention, names.join(',')).toBe(true)
      expect(config.standby_temperature_delta, names.join(',')).toBe(-150)
    }
  })

  it("matches the app's process for every printer, for the default process and for Standard", async () => {
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
          if (sectionOf(k) !== 'process' || MACHINE_FOLLOWING.has(k) || same(app[k], mcp[k])) continue
          differ.push(`${names.join(',')} ${k}: app ${JSON.stringify(app[k])}, server ${JSON.stringify(mcp[k])}`)
        }
      }
    }
    expect(differ).toEqual([])
  }, 300_000)
})
