// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A layer_height above what smart layer heights print, set without naming smart_layer, gets a warning on the slice; the
// default stays on and nothing is changed for the client.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { smartLayerCapNote } from '../src/smart-layer-cap'
import { connect, data, noSx, sxBin, sxTimeout } from './helpers'

const NOTE_04 = 'With smart layer heights on (smart_layer quality), layers are at most 0.20 mm, not the 0.28 mm layer_height. Set smart_layer to off for 0.28 mm layers.'

describe('the smart layer cap warning', () => {
  it('names the cap on a 0.4 and a 0.6 mm nozzle', () => {
    expect(smartLayerCapNote({ smart_layer: 'quality', nozzle_diameter: [0.4], layer_height: 0.28 }, { layer_height: 0.28 })).toBe(NOTE_04)
    expect(smartLayerCapNote({ smart_layer: 'strength', nozzle_diameter: [0.6], layer_height: 0.4 }, { layer_height: 0.4 })).toContain('at most 0.30 mm, not the 0.40 mm layer_height')
  })
  it('says nothing at exactly half the nozzle, with smart layers off, or when the client names smart_layer', () => {
    expect(smartLayerCapNote({ smart_layer: 'quality', nozzle_diameter: [0.4], layer_height: 0.2 }, { layer_height: 0.2 })).toBeNull()
    expect(smartLayerCapNote({ smart_layer: 'quality', nozzle_diameter: [0.6], layer_height: 0.3 }, { layer_height: 0.3 })).toBeNull()
    expect(smartLayerCapNote({ smart_layer: 'off', nozzle_diameter: [0.4], layer_height: 0.28 }, { layer_height: 0.28 })).toBeNull()
    expect(smartLayerCapNote({ smart_layer: 'quality', nozzle_diameter: [0.4], layer_height: 0.28 }, { layer_height: 0.28, smart_layer: 'quality' })).toBeNull()
  })
  it('says nothing when the layer height comes from a profile, not the call', () => {
    expect(smartLayerCapNote({ smart_layer: 'quality', nozzle_diameter: [0.4], layer_height: 0.28 }, {})).toBeNull()
    expect(smartLayerCapNote({ smart_layer: 'quality', nozzle_diameter: [0.4], layer_height: 0.28 }, undefined)).toBeNull()
  })
})

describe.skipIf(noSx())('slicerx_slice_file with a layer height above the smart layer cap', { timeout: sxTimeout }, () => {
  const slice = async (overrides: Record<string, unknown>) => {
    const h = await connect({ engine: 'sx', sxBin })
    try {
      const r = await h.call('slicerx_slice_file', { model: join(h.dir, 'cube.stl'), overrides })
      expect(r.isError).toBeFalsy()
      return data<{ warnings: string[] }>(r).warnings
    } finally {
      await h.client.close()
    }
  }

  it('warns on the default smart layers, and not once the client names smart_layer', async () => {
    expect(await slice({ layer_height: 0.28 })).toContain(NOTE_04)
    expect((await slice({ layer_height: 0.28, smart_layer: 'off' })).some((w) => w.startsWith('With smart layer heights on'))).toBe(false)
  })
})
