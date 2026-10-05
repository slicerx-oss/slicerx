// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Stepping the layer slider by key on a Bambu A1 style file: every press moves exactly one layer, none repeat
// or skip, and the move drawn on top always belongs to the layer shown.
import { describe, expect, it } from 'vitest'
import { currentSegment, indexLines, layerOfSegment } from '../src/workspaces/preview/gcode-lines'
import { parseGcodePreview } from '../src/workspaces/preview/gcode-parse'
import { layerKeyStep, stepLayer } from '../src/workspaces/preview/layer-step'
import { get, set } from '../src/state/store'

const LAYERS = 304

/** The A1 writes `; CHANGE_LAYER`, the layer's Z, a retract, a Z hop and a layer counter, then the walls. */
function a1File(purgeZ = '0.2'): string {
  const out = ['; HEADER_BLOCK_START', `; total layer number: ${LAYERS}`, '; HEADER_BLOCK_END', 'G90', 'M83', `G1 Z${purgeZ} F4000`, 'G1 X-48.2 Y0 F6000', 'G1 X-48.2 Y10 E5 F1800']
  for (let k = 1; k <= LAYERS; k++) {
    const z = (k * 0.2).toFixed(1)
    out.push('; CHANGE_LAYER', `; Z_HEIGHT: ${z}`, '; LAYER_HEIGHT: 0.2', 'G1 E-.8 F1800', `; layer num/total_layer_count: ${k}/${LAYERS}`, `M73 L${k}`, `M991 S0 P${k - 1} ;notify layer change`)
    out.push(`G1 Z${(k * 0.2 + 0.4).toFixed(1)} F4000`, `G1 Z${z}`, ';TYPE:Outer wall', ';WIDTH:0.42', ';HEIGHT:0.2')
    out.push('G1 X10 Y10 F30000', 'G1 E.8 F1800', 'G1 X50 Y10 E1.2 F3600', 'G1 X50 Y50 E1.2', 'G1 X10 Y50 E1.2', 'G1 X10 Y10 E1.2')
  }
  return out.join('\n') + '\n'
}

describe('the start purge', () => {
  it('joins layer 1, so the count matches the engine whatever height the purge is at', async () => {
    const pause = () => Promise.resolve()
    for (const purgeZ of ['0.2', '0.8', '0.3']) {
      const ix = await indexLines(new TextEncoder().encode(a1File(purgeZ)), { pause })
      const { preview } = await parseGcodePreview(ix, { pause })
      expect(preview.layerCount, `purge at Z${purgeZ}`).toBe(LAYERS)
      expect(preview.layerZ[0]).toBeCloseTo(0.2, 4)
      expect(preview.layerZ[LAYERS - 1]).toBeCloseTo(LAYERS * 0.2, 3)
    }
  })
})

describe('layer keys on an A1 file', () => {
  it('step one layer per press through every layer, up and back down', async () => {
    const pause = () => Promise.resolve()
    const ix = await indexLines(new TextEncoder().encode(a1File()), { pause })
    const { preview } = await parseGcodePreview(ix, { pause })
    expect(preview.layerCount).toBe(LAYERS)
    for (let k = 0; k < LAYERS; k++) expect(preview.layerStart[k + 1]! - preview.layerStart[k]!, `layer ${k + 1} has moves`).toBeGreaterThan(0)
    set({ preview, slice: { status: 'idle' }, layerHi: 1, layerLo: 1, moveCut: 1 })
    const up = layerKeyStep('ArrowUp')
    const down = layerKeyStep('ArrowDown')
    expect([up, down, layerKeyStep('PageUp'), layerKeyStep('a')]).toEqual([1, -1, 10, 0])
    for (let k = 2; k <= LAYERS; k++) {
      stepLayer(up)
      expect(get().layerHi, `press ${k - 1}`).toBe(k)
      expect(layerOfSegment(preview, currentSegment(preview, get().layerHi, get().moveCut)) + 1).toBe(k)
    }
    stepLayer(up)
    expect(get().layerHi).toBe(LAYERS)
    for (let k = LAYERS - 1; k >= 1; k--) {
      stepLayer(down)
      expect(get().layerHi, `press down to ${k}`).toBe(k)
    }
  })
})
