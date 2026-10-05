// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { energyFigure, plateMaterial, printerName, runPlateCheck } from '../src/plate/checks'

// A tall, thin post: the risk report has something to say about it.
function box(w: number, d: number, h: number) {
  const p = [0, 0, 0, w, 0, 0, w, d, 0, 0, d, 0, 0, 0, h, w, 0, h, w, d, h, 0, d, h]
  const i = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7]
  return { name: 'post', positions: new Float32Array(p), indices: new Uint32Array(i) }
}
const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const state = (parts = [box(8, 8, 60)]) =>
  ({
    plate: [{ id: 'o1', name: 'post', parts, transform: ident, colors: [] }],
    plates: [],
    activePlate: '',
    printerSlots: [],
    slotSetup: {},
    printerModel: { vendor: 'Bambu Lab', model: 'P1S' },
    profile: { nozzle: 0.4 },
    bed: { widthMm: 256, depthMm: 256, heightMm: 256 },
    easy: {},
    overrides: {},
  }) as never

describe('plate checks', () => {
  it('names the printer and the material', () => {
    expect(printerName({ printerModel: { vendor: 'Bambu Lab', model: 'P1S' } })).toBe('Bambu Lab P1S')
    expect(plateMaterial({ plate: [], plates: [], activePlate: '', printerSlots: [], slotSetup: {} } as never)).toBe('PLA')
  })

  it('runs the risk report on the plate as it sits and lists a finding with its fix', async () => {
    const c = await runPlateCheck('risks', state())
    expect(c.title).toBe('Print risks on this plate')
    expect(c.ok).toBe(true)
    expect(JSON.stringify(c.display)).toMatch(/tall|thin/i)
  })

  it('says to add a model when the plate is empty', async () => {
    const c = await runPlateCheck('risks', { ...(state() as object), plate: [] } as never)
    expect(c.ok).toBe(false)
    expect(c.summary).toMatch(/Add a model/)
  })

  it('runs the printer match without a connected printer', async () => {
    const c = await runPlateCheck('printers', state())
    expect(c.title).toBe('Printers that fit this plate')
    expect(typeof c.summary).toBe('string')
  })

  it('estimates electricity from print time, and skips a zero time', async () => {
    const f = await energyFigure(4 * 3600, 'Bambu Lab P1S', 'PLA')
    expect(f?.kwh).toBeGreaterThan(0.1)
    expect(f?.cost).toBeGreaterThan(0)
    expect(await energyFigure(0, 'x', 'PLA')).toBeNull()
  })
})
