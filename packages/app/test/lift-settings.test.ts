// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The two lift settings a person edits by hand: Z hop type in Printer settings (one row for every extruder) and a
// filament's own travel slope in the Filament dialog (one entry per filament slot). Both reach the slice request.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { Host, SliceRequest } from '@slicerx/contracts'
import { formatValue, settingDef } from '../src/adapters/settings'
import { setProfileLayer } from '../src/adapters/config'
import { parseSlope, slopeHint, slotSlope, withSlotSlope } from '../src/filament/slot-lift'
import { slicePlate } from '../src/state/actions'
import { get, set } from '../src/state/store'
import { Field, offeredValues } from '../src/workspaces/prepare/expert-settings'
import { printerKeys, setPrinterSetting, zHopTypeNote } from '../src/workspaces/prepare/printer-settings'

const handle = { id: 'a', hash: 'a', name: 'a', triangles: 1, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'a', slot: 1, triangles: 1 }] }
const entry = { id: 'a', name: 'a', handle, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } as never

/** A host whose slice records the request and then fails, which is enough to read the config. */
function capture(): { host: Host; requests: SliceRequest[] } {
  const requests: SliceRequest[] = []
  const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { slice: async (r: SliceRequest) => { requests.push(r); throw new Error('stop') }, loadParts: async () => handle } } as unknown as Host
  return { host, requests }
}

beforeEach(() => set({ overrides: {}, settingsMode: 'advanced' }))

describe('Z hop type in Printer settings', () => {
  let root: Root | null = null
  let el: HTMLElement | null = null
  afterEach(() => {
    if (root) flushSync(() => root!.unmount())
    el?.remove()
    root = null
    setProfileLayer(null, [])
  })
  function row(def: ReturnType<typeof settingDef>, value: unknown, onSet: (k: string, v: unknown) => void, note?: string): HTMLLIElement {
    el = document.createElement('div')
    document.body.append(el)
    root = createRoot(el)
    flushSync(() => root!.render(createElement(Field, { def: def!, value: value as never, overridden: false, onSet: onSet as never, idPrefix: 'ps', note })))
    return el.querySelector('li')!
  }

  it('is a printer row, and the other per-extruder lists stay out until their labels are checked', () => {
    const keys = printerKeys()
    expect(keys).toContain('z_hop_types')
    for (const k of ['nozzle_type', 'extruder_type', 'retract_lift_enforce', 'default_nozzle_volume_type']) expect(keys).not.toContain(k)
  })

  it('offers Auto, Normal, Slope, Spiral and Ramp by their labels', () => {
    const offered = offeredValues(settingDef('z_hop_types')!, 'Ramp Lift')
    expect(offered.map((o) => o.label)).toEqual(['Auto', 'Normal', 'Slope', 'Spiral', 'Ramp'])
    expect(offered.some((o) => o.gone)).toBe(false)
    expect(formatValue(settingDef('z_hop_types'), ['Ramp Lift'])).toBe('Ramp')
  })

  it('shows a select with plain labels and writes the pick as a list', () => {
    const picks: unknown[] = []
    const li = row(settingDef('z_hop_types'), ['Slope Lift'], (_k, v) => picks.push(v))
    const select = li.querySelector('select')!
    expect(select.disabled).toBe(false)
    expect([...select.options].map((o) => o.textContent)).toEqual(['Auto', 'Normal', 'Slope', 'Spiral', 'Ramp'])
    expect(li.textContent).not.toMatch(/Lift|z_hop_types/)
    select.value = 'Ramp Lift'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(picks).toEqual([['Ramp Lift']])
  })

  it('sets every extruder to the pick, keeps the list length, and a reset drops the change', () => {
    setPrinterSetting('z_hop_types', ['Ramp Lift'], undefined)
    expect(get().overrides['z_hop_types']).toEqual(['Ramp Lift'])
    setPrinterSetting('z_hop_types', undefined, undefined)
    expect(get().overrides).not.toHaveProperty('z_hop_types')
    setPrinterSetting('z_hop_types', ['Ramp Lift'], { z_hop_types: ['Slope Lift', 'Slope Lift'] } as never)
    expect(get().overrides['z_hop_types']).toEqual(['Ramp Lift', 'Ramp Lift'])
    setPrinterSetting('z_hop_types', ['Normal Lift'], undefined)
    expect(get().overrides['z_hop_types']).toEqual(['Normal Lift', 'Normal Lift'])
  })

  it('says when the type has no effect, and keeps the select enabled', () => {
    const note = zHopTypeNote({ z_hop: [0], z_hop_types: ['Slope Lift'] })
    expect(note).toBe('Z hop height is 0, so the nozzle does not lift.')
    expect(zHopTypeNote({ z_hop: [0.4], use_firmware_retraction: true, z_hop_types: ['Slope Lift'] })).toBe('This printer retracts with its own firmware commands, so the type is not used.')
    expect(zHopTypeNote({ z_hop: [0.4], z_hop_types: ['Slope Lift'] })).toBeUndefined()
    const li = row(settingDef('z_hop_types'), ['Slope Lift'], () => {}, note)
    expect(li.querySelector('select')!.disabled).toBe(false)
    expect(li.textContent).toContain('Z hop height is 0')
  })

  it('names the export form of a ramp and extruders that differ, two lines at most', () => {
    expect(zHopTypeNote({ z_hop: [0.4], z_hop_types: ['Ramp Lift'] })).toBe('Ramp is written as Slope when you export for Bambu Studio or OrcaSlicer.')
    expect(zHopTypeNote({ z_hop: [0.4], z_hop_types: ['Slope Lift', 'Spiral Lift'] })).toBe('The extruders use different types; choosing one sets both.')
    const all = zHopTypeNote({ z_hop: [0], z_hop_types: ['Ramp Lift', 'Slope Lift'] })!
    expect(all.match(/\.(\s|$)/g)).toHaveLength(2)
  })

  it("names a preset's own choice by its label, never its value", () => {
    setProfileLayer({ printer_model: 'Prusa MK4', wall_generator: 'classic' }, [])
    const li = row(settingDef('wall_generator'), 'aegis', () => {})
    const line = li.querySelector('.slicerx-default')!
    expect(line.textContent).toContain("This printer's preset says Classic.")
    expect(line.textContent).toContain("Use this preset's own (Classic)")
  })
})

describe("a filament's travel slope", () => {
  it('reads slot N from entry N - 1, falls back to the last entry, and treats empty, nil and [] as unset', () => {
    expect(slotSlope({ filament_travel_slope: [12, 20] }, 2)).toBe(20)
    expect(slotSlope({ filament_travel_slope: [12] }, 3)).toBe(12)
    expect(slotSlope({ filament_travel_slope: ['15'] }, 1)).toBe(15)
    expect(slotSlope({ filament_travel_slope: ['nil', 20] as never }, 1)).toBeUndefined()
    expect(slotSlope({ filament_travel_slope: [''] }, 1)).toBeUndefined()
    expect(slotSlope({ filament_travel_slope: [] }, 1)).toBeUndefined()
    expect(slotSlope({}, 1)).toBeUndefined()
  })

  it('writes one slot, spells out an imported one-entry list for the others, and drops the key when none is left', () => {
    expect(withSlotSlope({}, 1, 1, 12)).toEqual({ filament_travel_slope: [12] })
    expect(withSlotSlope({}, 2, 2, 20)).toEqual({ filament_travel_slope: ['nil', 20] })
    expect(withSlotSlope({ filament_travel_slope: ['30'] }, 2, 3, 20)).toEqual({ filament_travel_slope: ['30', 20, '30'] })
    expect(withSlotSlope({ filament_travel_slope: [12, 20] }, 1, 2, undefined)).toEqual({ filament_travel_slope: ['nil', 20] })
    expect(withSlotSlope({ filament_travel_slope: [12], wall_loops: 3 }, 1, 1, undefined)).toEqual({ wall_loops: 3 })
    // A value under the overrides (a filament preset) keeps the key, so clearing never brings that value back.
    expect(withSlotSlope({}, 1, 1, undefined, [25])).toEqual({ filament_travel_slope: ['nil'] })
  })

  it('clamps to 0 to 90, reverts text that is not a number, and clears on an empty field', () => {
    expect(parseSlope('-5')).toBe(0)
    expect(parseSlope('120')).toBe(90)
    expect(parseSlope('12.5')).toBe(12.5)
    expect(parseSlope('abc')).toBeNull()
    expect(parseSlope('  ')).toBeUndefined()
  })

  it("says what the slot climbs at and when the slope has no effect", () => {
    const lift = { z_hop: [0.4], z_hop_types: ['Ramp Lift'], travel_slope: [3] }
    expect(slopeHint(lift, 1)).toBe("Uses the printer's travel slope, 3°.")
    expect(slopeHint({ ...lift, filament_travel_slope: [15] }, 1)).toBe('Climbs at 15° for this filament.')
    expect(slopeHint({ ...lift, filament_travel_slope: [0] }, 1)).toBe('At 0°, a ramp lift climbs straight up and a slope or spiral lift uses 3°.')
    expect(slopeHint({ ...lift, z_hop_types: ['Normal Lift'] }, 1)).toBe("Uses the printer's travel slope, 3°. The lift type is Normal, so the slope is not used.")
    // Auto lifts slope or spiral, so the angle counts there.
    expect(slopeHint({ ...lift, z_hop_types: ['Auto Lift'] }, 1)).toBe("Uses the printer's travel slope, 3°.")
    // The slot's own lift type and height win over the printer's.
    expect(slopeHint({ ...lift, filament_z_hop_types: ['nil', 'Normal Lift'] }, 2)).toContain('The lift type is Normal')
    expect(slopeHint({ ...lift, filament_z_hop: [0] }, 1)).toContain('Z hop height is 0, so there is no lift.')
  })
})

describe('the slice request', () => {
  beforeEach(() => set({ plate: [entry], resume: null, slice: { status: 'idle' }, calibration: {}, layerMarks: {} }))

  it('carries the Z hop type and the travel slope set through the app controls', async () => {
    setPrinterSetting('z_hop_types', ['Ramp Lift'], undefined)
    set((s) => ({ overrides: withSlotSlope(s.overrides, 1, 1, 15) }))
    const { host, requests } = capture()
    await slicePlate(host)
    expect(requests[0]!.config['z_hop_types']).toEqual(['Ramp Lift'])
    expect(requests[0]!.config['filament_travel_slope']).toEqual([15])
  })

  it("carries slot 2's own slope with slot 1 left on the printer's value", async () => {
    set((s) => ({ overrides: withSlotSlope(s.overrides, 2, 2, 20) }))
    const { host, requests } = capture()
    await slicePlate(host)
    expect(requests[0]!.config['filament_travel_slope']).toEqual(['nil', 20])
  })
})
