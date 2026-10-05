// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import type { SvgImport } from '../src/geom/cad'
import { addSvgRelief, svgOptions } from '../src/cad/svg-import'
import { bounds } from '../src/plate/transform'
import { get, set } from '../src/state/store'

const host = { slicer: { loadParts: async (name: string) => ({ id: name, name, parts: [] }) } } as unknown as Host
const tri = (z: number) => ({ positions: [0, 0, 0, 10, 0, 0, 0, 10, z], indices: [0, 1, 2] })
const answer = (over: Partial<SvgImport> = {}): SvgImport => ({
  parts: [
    { name: 'color 1', color: '#ff0000', slot: 1, areaMm2: 50, mesh: tri(2), watertight: true },
    { name: 'color 2', color: '#0000ff', slot: 2, areaMm2: 30, mesh: tri(2), watertight: true },
  ],
  slotColors: ['#ff0000', '#0000ff'],
  sizeMm: [10, 10, 2],
  mmPerUnit: 1,
  warnings: [],
  ...over,
})

beforeEach(() => set({ plate: [], selection: null, selectedIds: [], toast: null }))

describe('svg import', () => {
  it('turns the form into engine options and rejects bad numbers in plain words', () => {
    expect(svgOptions({ heightMm: 2, baseMm: 1, widthMm: 40 })).toEqual({ heightMm: 2, baseMm: 1, fitWidthMm: 40 })
    expect(svgOptions({ heightMm: 2, baseMm: 0, widthMm: null })).toEqual({ heightMm: 2, baseMm: 0 })
    expect(svgOptions({ heightMm: 0, baseMm: 0, widthMm: null })).toBe('The relief height must be more than 0 mm.')
    expect(svgOptions({ heightMm: 2, baseMm: -1, widthMm: null })).toBe('The base thickness cannot be negative.')
    expect(svgOptions({ heightMm: 2, baseMm: 0, widthMm: 0 })).toBe('The width must be more than 0 mm.')
  })

  it('adds one object with a part and filament slot per color, standing on the bed', async () => {
    let seen: unknown
    const id = await addSvgRelief(host, 'logo.svg', '<svg/>', { heightMm: 2, baseMm: 0, widthMm: 10 }, async (_svg, o) => ((seen = o), answer()))
    expect(seen).toEqual({ heightMm: 2, baseMm: 0, fitWidthMm: 10 })
    const e = get().plate.find((p) => p.id === id)!
    expect(e.name).toBe('logo')
    expect(e.parts.map((p) => p.slot)).toEqual([1, 2])
    expect(e.colors).toEqual(['#ff0000', '#0000ff'])
    expect(bounds(e.parts, e.transform)!.min[2]).toBeCloseTo(0)
    expect(get().toast?.text).toBe('Added logo: 2 colors, 10 x 10 x 2 mm.')
  })

  it('passes the engine warnings on in a warning toast', async () => {
    await addSvgRelief(host, 'a.svg', '<svg/>', { heightMm: 2, baseMm: 0, widthMm: null }, async () => answer({ warnings: ['Strokes are not printed.'] }))
    expect(get().toast?.tone).toBe('warn')
    expect(get().toast?.text).toContain('Strokes are not printed.')
  })

  it('says what is wrong when nothing printable came out', async () => {
    await expect(addSvgRelief(host, 'a.svg', '<svg/>', { heightMm: 2, baseMm: 0, widthMm: null }, async () => answer({ parts: [] }))).rejects.toThrow('no filled shapes')
    expect(get().plate).toHaveLength(0)
  })
})
