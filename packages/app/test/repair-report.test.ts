// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import type { AutoImport } from '../src/geom/cad'
import { addAutoImport } from '../src/state/import-auto'
import { get, set } from '../src/state/store'
import { lastRepairForTest, repairChanged, repairHeadline, repairLines, showLastRepair, sumRepair } from '../src/plate/repair-report'

const host = { slicer: { loadParts: async (name: string) => ({ id: name, name, parts: [], triangles: 0 }) } } as unknown as Host

describe('repair report', () => {
  it('words every fix with its count', () => {
    const lines = repairLines({ holesFilled: 2, trianglesFlipped: 1, duplicatesRemoved: 4, verticesMerged: 10, holesLeftOpen: 1 })
    expect(lines).toEqual(['2 holes closed', '1 face flipped to point outward', '4 duplicate faces removed', '10 vertices merged', '1 hole too big to close, still open'])
  })

  it('says nothing is wrong when nothing changed', () => {
    expect(repairChanged({ holesFilled: 0 })).toBe(false)
    expect(repairHeadline({ holesFilled: 0, verticesMerged: 0 })).toBe('The mesh was already clean.')
    expect(repairLines({})).toEqual([])
  })

  it('flags what is left over in the headline', () => {
    expect(repairHeadline({ holesLeftOpen: 2 })).toBe('Nothing could be fixed automatically.')
    expect(repairHeadline({ holesFilled: 1, holesLeftOpen: 2 })).toBe('Repaired: 1 hole closed. Some problems remain.')
  })

  it('shortens a long headline', () => {
    const h = repairHeadline({ holesFilled: 1, trianglesFlipped: 2, duplicatesRemoved: 3, verticesMerged: 4 })
    expect(h).toBe('Repaired: 1 hole closed, 2 faces flipped to point outward, 3 duplicate faces removed and 1 more.')
  })

  it('sums parts and only the counts the engine sent', () => {
    const t = sumRepair([{ holesFilled: 1, watertight: true }, { holesFilled: 2, trianglesFlipped: 3, watertight: false }])
    expect(t).toEqual({ holesFilled: 3, trianglesFlipped: 3, watertight: false })
    expect(sumRepair([{}])).toEqual({})
  })
})

describe('repair details from an import', () => {
  beforeEach(() => set({ plate: [], selection: null, selectedIds: [], toast: null }))
  const run = (repair: object, summary: string[]) => async () =>
    ({
      name: 'f',
      format: 'stl',
      objects: [{ name: 'f', parts: [{ name: 'f', slot: 1, color: null, mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }, watertight: true }], repair }],
      unit: { unit: 'millimeter', scale: 1, confidence: 'high', autoApply: false, reason: '', sizeBefore: [1, 1, 1], sizeAfter: [1, 1, 1] },
      summary,
      warnings: [],
      slotColors: [],
    }) as unknown as AutoImport

  it('puts a Repair details action on the toast and remembers the report', async () => {
    await addAutoImport(host, 'f.stl', new ArrayBuffer(4), run({ holesFilled: 2 }, ['Repaired: closed 2 holes.']))
    expect(get().toast?.action?.label).toBe('Repair details')
    expect(lastRepairForTest()?.entries[0]?.report.holesFilled).toBe(2)
    expect(showLastRepair()).toBe(true)
  })

  it('adds no action when nothing was repaired', async () => {
    await addAutoImport(host, 'f.stl', new ArrayBuffer(4), run({ holesFilled: 0 }, ['Loaded as one object with 1 parts.']))
    expect(get().toast?.action).toBeUndefined()
  })
})
