// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { PrinterHost } from '@slicerx/contracts'
import { gcodeNotes, sendWarnings, spoolNotes } from '../src/plate/lint'

const gcode = (nozzle: number) =>
  [';FLAVOR:Marlin', 'M104 S' + nozzle, 'M140 S60', 'G28', 'G1 Z0.2 F600', ...Array.from({ length: 40 }, (_, i) => `G1 X${10 + i} Y${10 + (i % 2)} E${(i + 1) * 0.05} F3000`)].join('\n')

describe('send sheet preflight', () => {
  const info = { id: 'bay-1', name: 'Bay 1', vendor: 'Generic', model: 'Unknown', plugin: 'moonraker', filamentSystem: 'none' }
  const status = { state: 'idle', slots: [{ id: '1', material: 'PLA', remainingPct: 3 }], cameraAvailable: false }
  const host = { list: async () => [info], status: async () => status, callTool: async () => { throw new Error('none') } } as unknown as PrinterHost
  const result = { id: 'r', layerCount: 10, layerTimeS: new Float32Array(10).fill(60), stats: { timeS: 600, filamentG: [120] } } as never

  it('warns when the loaded spool will not last, from the sliced plate', async () => {
    const out = await sendWarnings({ data: new TextEncoder().encode(gcode(210)).buffer as ArrayBuffer, printers: host, printerId: 'bay-1', result, material: 'PLA' })
    expect(out.some((w) => /runs out/.test(w.text) && /3[0-9] g left/.test(w.tip ?? ''))).toBe(true)
  })

  // An AMS with no reading reports -1 (or 0 for a spool without a tag): that is not an empty spool, so nothing is said.
  for (const pct of [-1, 0, undefined]) {
    it(`says nothing about the spool when the remaining amount is ${pct === undefined ? 'missing' : pct}`, async () => {
      const unknown = { list: async () => [info], status: async () => ({ ...status, slots: [{ id: '1', material: 'PLA', ...(pct === undefined ? {} : { remainingPct: pct }) }] }), callTool: async () => { throw new Error('none') } } as unknown as PrinterHost
      const out = await sendWarnings({ data: new TextEncoder().encode(gcode(210)).buffer as ArrayBuffer, printers: unknown, printerId: 'bay-1', result, material: 'PLA' })
      expect(out.filter((w) => /spool|runs out|layer|weigh|reorder|enough/i.test(`${w.text} ${w.tip ?? ''}`))).toEqual([])
    })
  }

  // 0.2 mm of filament per mm at 50 mm/s is about 24 mm3/s: past PLA's generic standard hotend figure, inside an H2D PLA profile's 25.
  const fast = () => new TextEncoder().encode([';FLAVOR:Marlin', 'M104 S220', 'M83', 'G1 Z0.2 F600', ...Array.from({ length: 40 }, (_, i) => `G1 X${10 + i} Y10 E0.2 F3000`)].join('\n')).buffer as ArrayBuffer
  it('trusts the filament profile the plate was sliced with for the flow limit', async () => {
    const flow = (w: { text: string }) => /faster than/.test(w.text)
    expect((await sendWarnings({ data: fast(), printers: host, printerId: 'bay-1', result, material: 'PLA' })).some(flow)).toBe(true)
    expect((await sendWarnings({ data: fast(), printers: host, printerId: 'bay-1', result, material: 'PLA', maxFlowMm3s: 25 })).some(flow)).toBe(false)
    const over = await sendWarnings({ data: fast(), printers: host, printerId: 'bay-1', result, material: 'PLA', maxFlowMm3s: 12 })
    expect(over.find(flow)?.text).toBe('The G-code runs faster than its filament profile allows')
  })

  const sliced = (timeS: number) => ({ id: 'r', layerCount: 10, layerTimeS: new Float32Array(10).fill(60), stats: { timeS, filamentG: [5] } }) as never
  const file = () => new TextEncoder().encode(gcode(210)).buffer as ArrayBuffer

  it('adds the overnight checks once the print runs past eight hours', async () => {
    const out = await sendWarnings({ data: file(), printers: host, printerId: 'bay-1', result: sliced(10 * 3600), material: 'PLA' })
    expect(out.some((w) => /^No camera/.test(w.text))).toBe(true)
  })

  it('leaves them out of a short print', async () => {
    const out = await sendWarnings({ data: file(), printers: host, printerId: 'bay-1', result: sliced(2 * 3600), material: 'PLA' })
    expect(out.some((w) => /long print/.test(w.text))).toBe(false)
  })

  it('words a nozzle far outside the material range, and says nothing inside it', async () => {
    const hot = await sendWarnings({ data: new TextEncoder().encode(gcode(300)).buffer as ArrayBuffer, printers: host, printerId: 'bay-1', result: sliced(600), material: 'PLA' })
    expect(hot.map((w) => w.text)).toContain('Nozzle at 300 C is too hot for PLA')
    const fine = await sendWarnings({ data: file(), printers: host, printerId: 'bay-1', result: sliced(600), material: 'PLA' })
    expect(fine.some((w) => /Nozzle at/.test(w.text))).toBe(false)
  })

  it('reads no G-code findings from a file that is not G-code', async () => {
    const out = await sendWarnings({ data: new TextEncoder().encode('PK\u0003\u0004 not gcode').buffer as ArrayBuffer, printers: host, printerId: 'bay-1', result: sliced(600), material: 'PLA' })
    expect(out.some((w) => /Nozzle at|faster than/.test(w.text))).toBe(false)
  })
})

describe('send sheet notes', () => {
  it('words sustained flow and temperature in plain words, numbers in the tip', () => {
    const notes = gcodeNotes({ facts: [{ kind: 'flow', material: 'PLA', mm3s: 26, limit: 21, highFlow: 32 }, { kind: 'temp', material: 'PLA', c: 260, lo: 190, hi: 230 }] })
    expect(notes.map((n) => n.text)).toEqual(['Prints faster than PLA melts in a standard hotend', 'Nozzle at 260 C is too hot for PLA'])
    expect(notes[0]!.tip).toContain('21 mm3/s')
  })

  it('says nothing for a spool that covers the print or an unknown amount', () => {
    expect(spoolNotes({ status: 'pass', availG: 500, availSource: 'estimated', needG: 100 })).toEqual([])
    expect(spoolNotes({ status: 'warn', availG: null, availSource: 'unknown', needG: 100, swapAfterLayer: 0, layerCount: 304 })).toEqual([])
  })

  it('names the AMS backup instead of a swap when one has enough', () => {
    const [n] = spoolNotes({ status: 'fail', slot: 'A1', availG: 40, availSource: 'estimated', needG: 120, autoRefill: true, backups: [{ slot: 'A3', grams: 600, enough: true }], swapAfterLayer: 100, layerCount: 304 })
    expect(n!.text).toBe('A1 may run out; the AMS then switches to A3')
  })

  it('gives the swap layer only when it is past the first', () => {
    expect(spoolNotes({ status: 'fail', slot: 'A1', availG: 40, availSource: 'estimated', needG: 120, swapAfterLayer: 100, layerCount: 304 })[0]!.tip).toContain('layer 100 of 304')
    expect(spoolNotes({ status: 'fail', slot: 'A1', availG: 2, availSource: 'estimated', needG: 120, swapAfterLayer: 0, layerCount: 304 })[0]!.tip).not.toContain('layer 0')
  })
})
