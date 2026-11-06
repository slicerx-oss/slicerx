// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Bambu Lab H3C holds nine hotends on one extruder. The Filament block shows which tool prints each filament in
// use: the slicer's pick until the person picks one, 2.85 mm TPU fixed on the TPU tool, and no other filament on it.
// A pick by hand reaches the engine as a manual map of hotends.
import type { SliceResult } from '@slicerx/contracts'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { setProfileLayer } from '../src/adapters/config'
import { HotendRows } from '../src/filament/ams-panel'
import { currentHotends, hotendMapConfig, mapHotends, setHotendAuto, setSlotHotend, toolName } from '../src/filament/nozzle-map'
import type { ResolvedSlot } from '../src/filament/slots'
import { plateConfig } from '../src/plate/plates'
import { appStore, get, set } from '../src/state/store'

const TYPES = ['Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'Standard', 'TPU285', 'Standard']
const H3C = { printer_model: 'Bambu Lab H3C', nozzle_diameter: [0.4], extruder_max_nozzle_count: [9], default_nozzle_volume_type: TYPES, ams_nozzle_idx: [0], single_extruder_multi_material: true, filament_diameter: [1.75, 2.85, 1.75] }

const slot = (index: number, color: string, type = 'PLA'): ResolvedSlot => ({ index, label: String(index), type, brand: '', color, source: 'user', used: true })

const done = (filamentMap?: SliceResult['filamentMap']): SliceResult =>
  ({ id: 's1', engine: 'sx', layerCount: 1, layerZ: new Float32Array(1), layerTimeS: new Float32Array(1), stats: { timeS: 1, filamentMm: [], filamentG: [], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1, warnings: [], ...(filamentMap ? { filamentMap } : {}) }) as SliceResult

afterEach(() => {
  setProfileLayer(null, [])
  set({ plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', slice: { status: 'idle' } })
  document.body.innerHTML = ''
})

describe('hotend map', () => {
  it('belongs to printers whose hotends are their tools', () => {
    expect(mapHotends(H3C)).toBe(9)
    expect(mapHotends({ printer_model: 'Bambu Lab H2C', nozzle_diameter: [0.4, 0.4], extruder_max_nozzle_count: [1, 6] })).toBe(0)
    expect(mapHotends({ printer_model: 'Bambu Lab P1S', nozzle_diameter: [0.4] })).toBe(0)
    expect(toolName(1, false)).toBe('Tool 1')
    expect(toolName(8, true)).toBe('Tool 8, TPU 2.85 mm')
  })

  it('shows the slicer pick before and after a slice, the plate pick over both, and sends a manual map', () => {
    const plate = { settings: { sequence: 'by-layer' as const } }
    // Before a slice: the rule the engine uses, 2.85 mm TPU on tool 8, the others on the next free tools.
    expect(currentHotends(plate, undefined, H3C, 3, [1, 2, 3])).toEqual([1, 8, 2])
    // After one: what the engine reported (0-based hotends).
    expect(currentHotends(plate, { extruders: [1, 1, 1], nozzles: [2, 7, 0], auto: true }, H3C, 3, [1, 2, 3])).toEqual([3, 8, 1])
    expect(hotendMapConfig(plate)).toEqual({})
    const own = { settings: { sequence: 'by-layer' as const, hotendMap: [4, 8, 1] } }
    expect(currentHotends(own, { extruders: [1, 1, 1], nozzles: [2, 7, 0], auto: true }, H3C, 3, [1, 2, 3])).toEqual([4, 8, 1])
    expect(plateConfig({ id: 'p', name: 'P', objects: [], ...own })).toEqual({ print_sequence: 'by layer', filament_map_mode: 'Manual', filament_nozzle_map: [3, 7, 0] })
  })

  it('setting one filament keeps the others on their tools and turns the pick off', () => {
    setSlotHotend('plate-1', 3, 5, [1, 8, 2])
    expect(get().plates[0]!.settings.hotendMap).toEqual([1, 8, 5])
    setHotendAuto('plate-1')
    expect(get().plates[0]!.settings.hotendMap).toBeUndefined()
  })
})

describe('tool rows in the Filament block', () => {
  const render = (slots: ResolvedSlot[]) => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    flushSync(() => root.render(createElement(HotendRows, { slots })))
    return el
  }

  it('lists the nine tools per filament, keeps 2.85 mm TPU on the TPU tool, and says the tool number is not settled', () => {
    setProfileLayer(H3C, [])
    const el = render([slot(1, '#ff6a13'), slot(2, '#222222', 'TPU'), slot(3, '#0a2989')])
    const selects = [...el.querySelectorAll('select')]
    expect(selects.map((s) => s.getAttribute('aria-label'))).toEqual(['Tool for filament 1', 'Tool for filament 2', 'Tool for filament 3'])
    expect(selects.map((s) => s.value)).toEqual(['1', '8', '2'])
    expect([...selects[0]!.options].map((o) => o.textContent)).toEqual(['Tool 1', 'Tool 2', 'Tool 3', 'Tool 4', 'Tool 5', 'Tool 6', 'Tool 7', 'Tool 8, TPU 2.85 mm', 'Tool 9'])
    // No other filament on the TPU tool; the 2.85 mm TPU on nothing else.
    expect(selects[0]!.options[7]!.disabled).toBe(true)
    expect(selects[1]!.disabled).toBe(true)
    const tpu = el.querySelector('[data-slot="2"]')!
    expect(tpu.textContent).toContain('2.85 mm TPU prints only on the TPU tool')
    // The hardware question, in plain words and without setting names.
    const note = el.querySelector('[data-testid="hotend-tpu-note"]')!
    expect(note.textContent).toContain('tool 8')
    expect(note.textContent).toContain('tool 7')
    expect(note.textContent).not.toMatch(/[a-z]+_[a-z]+/)
    // A pick by hand sets the plate map.
    selects[2]!.value = '6'
    flushSync(() => selects[2]!.dispatchEvent(new Event('change', { bubbles: true })))
    expect(appStore.getState().plates[0]!.settings.hotendMap).toEqual([1, 8, 6])
  })

  it('shows what the slicer picked after a slice', () => {
    setProfileLayer(H3C, [])
    set({ slice: { status: 'done', result: done({ extruders: [1, 1], nozzles: [4, 7], auto: true }), stale: false } })
    const el = render([slot(1, '#ff6a13'), slot(2, '#222222', 'TPU')])
    expect([...el.querySelectorAll('select')].map((s) => s.value)).toEqual(['5', '8'])
  })

  it('stays out of the way on other printers', () => {
    setProfileLayer({ printer_model: 'Bambu Lab H2D', nozzle_diameter: [0.4, 0.4], single_extruder_multi_material: true }, [])
    expect(render([slot(1, '#ff6a13')]).querySelector('.hotend-map')).toBeNull()
  })
})
