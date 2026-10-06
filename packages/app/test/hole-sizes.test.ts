// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The hole tool turns what a hole is for into its size: a screw that passes (the usual clearance hole, or the
// measured fit when that is looser), a screw that cuts its own thread, or a heat-set insert, with a counterbore or
// a countersink for the head. The sizes are usual ones, said to be so until a test print confirms them.
import { describe, expect, it } from 'vitest'
import { holeSpecFor } from '../src/cad/hole-sizes'
import type { Clearance } from '../src/plate/clearance'

const measured = (mm: number): Clearance => ({ mm, measured: true, words: `${mm.toFixed(2)} mm a side, from your hole test.` })
const nozzle: Clearance = { mm: 0.2, measured: false, words: '0.20 mm a side, half the 0.4 mm nozzle.' }
const through = { through: true, depthMm: 5 }
const blind = { through: false, depthMm: 4 }

describe('hole sizes', () => {
  it('lets a screw pass with the usual clearance, or the measured fit when looser', () => {
    expect(holeSpecFor({ purpose: 'clearance', thread: 'M3', head: 'none' }, measured(0.15), through).spec.diameterMm).toBeCloseTo(3.4)
    expect(holeSpecFor({ purpose: 'clearance', thread: 'M3', head: 'none' }, measured(0.3), through).spec.diameterMm).toBeCloseTo(3.6)
    const r = holeSpecFor({ purpose: 'clearance', thread: 'M3', head: 'none' }, nozzle, through)
    expect(r.words.join(' ')).toMatch(/M3 screw passes/)
  })

  it('sizes a hole for a screw to cut its thread, and for a heat-set insert one longer than the insert', () => {
    expect(holeSpecFor({ purpose: 'tap', thread: 'M3', head: 'none' }, nozzle, through).spec.diameterMm).toBeCloseTo(2.5)
    const insert = holeSpecFor({ purpose: 'insert', thread: 'M3', head: 'none' }, nozzle, blind)
    expect(insert.spec.diameterMm).toBeCloseTo(4)
    expect(insert.spec.depthMm).toBeCloseTo(6.7)
    expect(insert.label).toBe('M3 insert')
    // A through hole stays through.
    expect(holeSpecFor({ purpose: 'insert', thread: 'M3', head: 'none' }, nozzle, through).spec.depthMm).toBeUndefined()
  })

  it('adds a head for socket and flat head screws', () => {
    const bore = holeSpecFor({ purpose: 'clearance', thread: 'M3', head: 'counterbore' }, nozzle, through).spec
    expect(bore.counterbore).toEqual({ diameterMm: 6.5, depthMm: 3.4 })
    const sink = holeSpecFor({ purpose: 'clearance', thread: 'M3', head: 'countersink' }, nozzle, through).spec
    expect(sink.countersink?.diameterMm).toBeCloseTo(7.12)
    expect(sink.countersink?.angleDeg).toBe(90)
  })

  it('takes a typed size as it is', () => {
    const r = holeSpecFor({ purpose: 'custom', thread: 'M3', head: 'none', customMm: 4.2 }, nozzle, through)
    expect(r.spec).toEqual({ diameterMm: 4.2 })
    expect(r.label).toBe('Hole 4.2 mm')
  })

  it('says the usual sizes are not yet checked by a print', () => {
    expect(holeSpecFor({ purpose: 'insert', thread: 'M4', head: 'none' }, nozzle, blind).words.join(' ')).toMatch(/usual size/i)
  })
})
