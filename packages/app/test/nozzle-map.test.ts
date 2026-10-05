// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { SliceResult } from '@slicerx/contracts'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { setProfileLayer } from '../src/adapters/config'
import { NozzleRows } from '../src/filament/ams-panel'
import { currentMap, hasRack, mapExtruders, masterExtruder, nozzleMapConfig, nozzleName, setNozzleAuto, setSlotNozzle } from '../src/filament/nozzle-map'
import type { ResolvedSlot } from '../src/filament/slots'
import { plateConfig } from '../src/plate/plates'
import { appStore, get, set } from '../src/state/store'

const H2D = { printer_model: 'Bambu Lab H2D', nozzle_diameter: [0.4, 0.4], master_extruder_id: 2, single_extruder_multi_material: true }
const H2C = { ...H2D, printer_model: 'Bambu Lab H2C', extruder_max_nozzle_count: [1, 6] }

const slot = (index: number, color: string): ResolvedSlot => ({ index, label: String(index), type: 'PLA', brand: '', color, source: 'user', used: true })

const done = (filamentMap?: SliceResult['filamentMap']): SliceResult =>
  ({ id: 's1', engine: 'sx', layerCount: 1, layerZ: new Float32Array(1), layerTimeS: new Float32Array(1), stats: { timeS: 1, filamentMm: [], filamentG: [], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1, warnings: [], ...(filamentMap ? { filamentMap } : {}) }) as SliceResult

afterEach(() => {
  setProfileLayer(null, [])
  set({ plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', slice: { status: 'idle' } })
  document.body.innerHTML = ''
})

describe('filament map', () => {
  it('belongs to Bambu Lab printers with two extruders', () => {
    expect(mapExtruders(H2D)).toBe(2)
    expect(mapExtruders(H2C)).toBe(2)
    expect(hasRack(H2C)).toBe(true)
    expect(hasRack(H2D)).toBe(false)
    // One head per filament, or one nozzle: no map to pick.
    expect(mapExtruders({ printer_model: 'Snapmaker U1', nozzle_diameter: [0.4, 0.4, 0.4, 0.4], single_extruder_multi_material: false })).toBe(0)
    expect(mapExtruders({ printer_model: 'Bambu Lab P1S', nozzle_diameter: [0.4] })).toBe(0)
    expect(masterExtruder(H2D)).toBe(2)
    expect(nozzleName(1, false)).toBe('Left nozzle')
    expect(nozzleName(2, true)).toBe('Right hotend rack')
  })

  it('is the slicer pick until the plate sets one, then reaches the engine as a manual map', () => {
    const plate = { settings: { sequence: 'by-layer' as const } }
    expect(nozzleMapConfig(plate)).toEqual({})
    expect(plateConfig({ id: 'p', name: 'P', objects: [], ...plate })).toEqual({ print_sequence: 'by layer' })
    // Before a slice every filament shows the master extruder; after one, what the slicer picked.
    expect(currentMap(plate, undefined, 2, 2)).toEqual([2, 2])
    expect(currentMap(plate, { extruders: [2, 1], nozzles: [1, 0], auto: true }, 2, 2)).toEqual([2, 1])
    const own = { settings: { sequence: 'by-layer' as const, nozzleMap: [1, 1] } }
    expect(currentMap(own, { extruders: [2, 1], nozzles: [1, 0], auto: true }, 2, 2)).toEqual([1, 1])
    expect(plateConfig({ id: 'p', name: 'P', objects: [], ...own })).toEqual({ print_sequence: 'by layer', filament_map_mode: 'Manual', filament_map: [1, 1] })
  })

  it('setting one slot keeps the others where they print and turns the pick off', () => {
    setSlotNozzle('plate-1', 2, 2, [2, 1])
    expect(get().plates[0]!.settings.nozzleMap).toEqual([2, 2])
    setSlotNozzle('plate-1', 3, 1, [2, 2])
    expect(get().plates[0]!.settings.nozzleMap).toEqual([2, 2, 1])
    setNozzleAuto('plate-1')
    expect(get().plates[0]!.settings.nozzleMap).toBeUndefined()
  })
})

describe('nozzle rows in the Filament block', () => {
  const render = () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    const slots = [slot(1, '#ff6a13'), slot(2, '#0a2989')]
    flushSync(() => root.render(createElement(NozzleRows, { slots })))
    return el
  }

  it('shows what the slicer picked for each filament, and a pick by hand sets the plate map', () => {
    setProfileLayer(H2D, [])
    set({ slice: { status: 'done', result: done({ extruders: [2, 1], nozzles: [1, 0], auto: true }), stale: false } })
    const el = render()
    const selects = [...el.querySelectorAll('select')]
    expect(selects.map((s) => s.getAttribute('aria-label'))).toEqual(['Nozzle for filament 1', 'Nozzle for filament 2'])
    expect(selects.map((s) => s.value)).toEqual(['2', '1'])
    expect([...selects[0]!.options].map((o) => o.textContent)).toEqual(['Left nozzle', 'Right nozzle'])
    const auto = el.querySelector<HTMLInputElement>('#nozzle-auto')
    expect(auto?.getAttribute('aria-checked') ?? String(auto?.checked)).toBe('true')
    // Both filaments on the left nozzle: an AMS swap at every change, by the person's choice.
    selects[0]!.value = '1'
    flushSync(() => selects[0]!.dispatchEvent(new Event('change', { bubbles: true })))
    expect(appStore.getState().plates[0]!.settings.nozzleMap).toEqual([1, 1])
  })

  it('names the H2C rack and asks for a slice before the pick is known', () => {
    setProfileLayer(H2C, [])
    const el = render()
    expect([...el.querySelector('select')!.options].map((o) => o.textContent)).toEqual(['Left nozzle', 'Right hotend rack'])
    expect(el.textContent).toContain('Slice the plate to see where each filament goes.')
  })

  it('stays out of the way on a printer without a filament map', () => {
    setProfileLayer({ printer_model: 'Bambu Lab P1S', nozzle_diameter: [0.4] }, [])
    expect(render().querySelector('.nozzle-map')).toBeNull()
  })
})
