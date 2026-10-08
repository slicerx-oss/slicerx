// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The toolpath colors a slice opens in: filament when more than one tool prints, else feature type, unless the person
// picked colors themselves. The legend says what the colors show and, by filament, lists each slot.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SXPV_SEGMENT, SXPV_SEGMENT_BYTES, type MeshHandle, type PreviewBuffers, type SliceWarning } from '@slicerx/contracts'
import { defaultColorMode } from '../src/lib/preview-stats'
import { jumpToWarning } from '../src/lib/warning-actions'
import { colorModeAfterSlice, get, pickColorMode, set, type PlateEntry } from '../src/state/store'
import { Legend } from '../src/workspaces/preview/preview-hud'

/** One layer of 10 mm moves, one per entry, each printed by that entry's tool. */
function preview(tools: number[], toolCount = Math.max(...tools) + 1): PreviewBuffers {
  const raw = new ArrayBuffer(tools.length * SXPV_SEGMENT_BYTES)
  const v = new DataView(raw)
  tools.forEach((t, i) => {
    const o = i * SXPV_SEGMENT_BYTES
    v.setFloat32(o + SXPV_SEGMENT.x1, 10, true)
    v.setUint8(o + SXPV_SEGMENT.tool, t)
    v.setUint16(o + SXPV_SEGMENT.speedDeciMmS, 500, true)
  })
  return { raw, segmentCount: tools.length, layerCount: 1, layerStart: Uint32Array.from([0, tools.length]), layerTimeS: Float32Array.from([1]), segmentsOffset: 0, toolCount, extrasOffset: -1 } as unknown as PreviewBuffers
}

/** What a slice landing does to the colors (state/actions.ts slicePlate). */
const land = (p: PreviewBuffers) => set({ preview: p, ...colorModeAfterSlice(get(), defaultColorMode(p)) })

const handle = (id: string, slots: number[]): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: slots.map((slot, i) => ({ name: `p${i}`, slot, triangles: 12 })) })
const entry = (slots: number[], colors: string[]): PlateEntry => ({ id: 'a', name: 'a', handle: handle('a', slots), parts: [], colors, transform: [] })

beforeEach(() => set({ preview: null, colorMode: 'feature', colorModePicked: false, colorModeAuto: null, plate: [], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', printerSlots: [], slotSetup: {}, fileSlotColors: [] }))
afterEach(cleanup)

describe('the toolpath colors after a slice', () => {
  it('are by filament when two tools print, by feature when one does', () => {
    expect(defaultColorMode(preview([0, 1]))).toBe('tool')
    expect(defaultColorMode(preview([0, 0]))).toBe('feature')
    // A slot the slice has but never prints with does not count.
    expect(defaultColorMode(preview([1, 1], 3))).toBe('feature')
    land(preview([0, 1]))
    expect(get().colorMode).toBe('tool')
    land(preview([0]))
    expect(get().colorMode).toBe('feature')
  })

  it('keep a pick through a re-slice of the same kind, and follow the print when it gains or loses colors', () => {
    land(preview([0, 1]))
    pickColorMode('speed')
    land(preview([0, 1]))
    expect(get().colorMode).toBe('speed')
    land(preview([0]))
    expect(get().colorMode).toBe('feature')
    expect(get().colorModePicked).toBe(false)
  })

  it('count a warning jump as a pick', () => {
    set({ preview: preview([0, 1]), colorModeAuto: 'tool', colorMode: 'tool' })
    jumpToWarning({ code: 'unsupported_setting', message: 'Volumetric speed capped at 12 mm3/s', severity: 'warning' } as SliceWarning)
    expect(get().colorMode).toBe('flow')
    land(preview([0, 1]))
    expect(get().colorMode).toBe('flow')
  })
})

describe('the legend', () => {
  it('shows each printing slot with its color and length by filament', () => {
    set({ plate: [entry([1, 2], ['#ff0000', '#00ff00'])] })
    act(() => land(preview([0, 1, 1])))
    render(createElement(Legend))
    expect(screen.getByTestId('legend-color-by').textContent).toContain('Filament')
    const rows = screen.getAllByTestId('legend-slot')
    expect(rows.map((r) => r.getAttribute('data-slot'))).toEqual(['1', '2'])
    expect(rows[1]!.textContent).toContain('0.02 m')
    expect((rows[0]!.querySelector('.swatch') as HTMLElement).style.getPropertyValue('--c')).toBe('#ff0000')
  })

  it('picks the colors from its labeled Color by menu', () => {
    act(() => land(preview([0])))
    render(createElement(Legend))
    expect(screen.getByRole('button', { name: 'Color by Feature type' })).toBeTruthy()
    expect(screen.queryAllByTestId('legend-slot')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('legend-color-by'))
    fireEvent.click(screen.getByTestId('legend-color-layer-time'))
    expect(get().colorMode).toBe('layerTime')
    expect(get().colorModePicked).toBe(true)
  })
})
