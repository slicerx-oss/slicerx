// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A filament's own Z hop height and type in the Filament dialog: the rows, what they write (one entry per filament slot),
// what a project or a filament profile brings in, and that the slice request carries them.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Host, SliceRequest } from '@slicerx/contracts'
import { projectSettingChanges } from '@slicerx/settings'
import { resolveConfig } from '../src/adapters/config'
import { perSlot } from '../src/adapters/profile'
import { settingDef } from '../src/adapters/settings'
import { SlotDialog } from '../src/filament/dialogs'
import { heightHint, HEIGHT_KEY, HEIGHT_MAX, HEIGHT_MIN, LIFT_TYPES, parseHeight, slotHeight, slotType, typeHint, TYPE_KEY, withSlotValue } from '../src/filament/slot-lift'
import { HostContext } from '../src/host'
import { slicePlate } from '../src/state/actions'
import { get, set } from '../src/state/store'

const HOST = { kind: 'web', capabilities: { secureStorage: false } } as unknown as Host
const mount = () => render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(HostContext.Provider, { value: HOST }, createElement(SlotDialog))))

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as HTMLDialogElement & { showModal: () => void }
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})
// Two filament slots, so slot 2 has a dialog of its own.
beforeEach(() => set({ overrides: {}, settingsMode: 'advanced', slotDialog: null, slotSetup: { 2: { type: 'PETG', brand: '', color: '#3366ff' } } }))
afterEach(() => {
  cleanup()
  set({ slotDialog: null, overrides: {}, slotSetup: {} })
})

describe('the lift helpers', () => {
  it('match the schema: range, values and names', () => {
    const height = settingDef(HEIGHT_KEY)!
    expect([height.min, height.max]).toEqual([HEIGHT_MIN, HEIGHT_MAX])
    const type = settingDef(TYPE_KEY)!
    expect(LIFT_TYPES.map((t) => t.value)).toEqual(type.enumValues)
    expect(LIFT_TYPES.map((t) => t.label)).toEqual(type.enumLabels)
  })

  it("read a slot's own entry with the engine's fallback, and nil as the printer's value", () => {
    expect(slotHeight({ filament_z_hop: [0.6, 0.8] }, 2)).toBe(0.8)
    expect(slotHeight({ filament_z_hop: ['0.6'] }, 3)).toBe(0.6)
    expect(slotHeight({ filament_z_hop: ['nil', 0.8] as never }, 1)).toBeUndefined()
    expect(slotHeight({ filament_z_hop: [] }, 1)).toBeUndefined()
    expect(slotType({ filament_z_hop_types: ['nil', 'Ramp Lift'] }, 2)).toBe('Ramp Lift')
    expect(slotType({ filament_z_hop_types: ['nil', 'Ramp Lift'] }, 1)).toBeUndefined()
    expect(slotType({}, 1)).toBeUndefined()
  })

  it('write one slot and keep the others', () => {
    expect(withSlotValue(HEIGHT_KEY, {}, 2, 2, 0.6)).toEqual({ filament_z_hop: ['nil', 0.6] })
    expect(withSlotValue(TYPE_KEY, { filament_z_hop_types: ['Normal Lift'] }, 2, 3, 'Ramp Lift')).toEqual({ filament_z_hop_types: ['Normal Lift', 'Ramp Lift', 'Normal Lift'] })
    expect(withSlotValue(TYPE_KEY, { filament_z_hop_types: ['Ramp Lift'], wall_loops: 3 }, 1, 1, undefined)).toEqual({ wall_loops: 3 })
  })

  it('clamp the height to 0 to 5 mm, revert text, and clear on an empty field', () => {
    expect(parseHeight('-1')).toBe(0)
    expect(parseHeight('9')).toBe(5)
    expect(parseHeight('0.6')).toBe(0.6)
    expect(parseHeight('high')).toBeNull()
    expect(parseHeight('')).toBeUndefined()
  })

  it('say what the slot lifts and when it has no effect, by plain names', () => {
    const printer = { z_hop: [0.4], z_hop_types: ['Slope Lift'] }
    expect(heightHint(printer, 1)).toBe("Uses the printer's Z hop height, 0.4 mm.")
    expect(heightHint({ ...printer, filament_z_hop: [0.6] }, 1)).toBe('Lifts 0.6 mm for this filament.')
    expect(heightHint({ ...printer, filament_z_hop: [0] }, 1)).toBe('At 0 mm, this filament does not lift.')
    expect(heightHint({ ...printer, use_firmware_retraction: true }, 1)).toContain('so Z hop is not used')
    expect(typeHint(printer, 1)).toBe("Uses the printer's Z hop type, Slope.")
    expect(typeHint({ ...printer, filament_z_hop_types: ['Ramp Lift'] }, 1)).toBe('Lifts with Ramp for this filament.')
    expect(typeHint({ ...printer, filament_z_hop: [0] }, 1)).toBe("Uses the printer's Z hop type, Slope. Z hop height is 0, so there is no lift.")
    expect(typeHint({ ...printer, use_firmware_retraction: [1] }, 1)).toContain('so the type is not used')
    for (const hint of [heightHint(printer, 1), typeHint({ ...printer, filament_z_hop_types: ['Spiral Lift'] }, 1)]) expect(hint).not.toMatch(/filament_|z_hop|Lift\b/)
  })
})

describe('the Filament dialog', () => {
  it('shows Z hop height and Z hop type above the travel slope in Advanced, and none of them in Simple', () => {
    set({ slotDialog: 1 })
    mount()
    const height = screen.getByTestId('slot-z-hop') as HTMLInputElement
    const type = screen.getByTestId('slot-z-hop-type') as HTMLSelectElement
    const slope = screen.getByTestId('slot-travel-slope')
    expect(height.compareDocumentPosition(type) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(type.compareDocumentPosition(slope) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByLabelText('Z hop height mm')).toBe(height)
    expect(screen.getByLabelText('Z hop type')).toBe(type)
    expect([...type.options].map((o) => o.textContent)).toEqual(['Printer value', 'Auto', 'Normal', 'Slope', 'Spiral', 'Ramp'])
    expect(type.value).toBe('')
    expect(height.value).toBe('')
    expect(height.placeholder).toBe('Printer value')
    act(() => set({ settingsMode: 'simple' }))
    expect(screen.queryByTestId('slot-z-hop')).toBeNull()
    expect(screen.queryByTestId('slot-z-hop-type')).toBeNull()
  })

  it("edits only this slot's entries, and clears them back to the printer's", () => {
    set({ slotDialog: 2, overrides: { filament_z_hop: [0.4, 0.4] } })
    mount()
    const height = screen.getByTestId('slot-z-hop') as HTMLInputElement
    fireEvent.change(height, { target: { value: '0.8' } })
    fireEvent.blur(height)
    expect(get().overrides[HEIGHT_KEY]).toEqual([0.4, 0.8])
    fireEvent.change(screen.getByTestId('slot-z-hop-type'), { target: { value: 'Ramp Lift' } })
    const types = get().overrides[TYPE_KEY] as unknown[]
    expect(types[1]).toBe('Ramp Lift')
    expect(types.filter((t, i) => i !== 1).every((t) => t === 'nil')).toBe(true)
    expect(screen.getByText('Lifts with Ramp for this filament.')).toBeTruthy()
    // Text that is not a number goes back; an empty field and Printer value clear the slot.
    const again = screen.getByTestId('slot-z-hop') as HTMLInputElement
    fireEvent.change(again, { target: { value: 'abc' } })
    fireEvent.blur(again)
    expect(get().overrides[HEIGHT_KEY]).toEqual([0.4, 0.8])
    const last = screen.getByTestId('slot-z-hop') as HTMLInputElement
    fireEvent.change(last, { target: { value: '' } })
    fireEvent.blur(last)
    expect(get().overrides[HEIGHT_KEY]).toEqual([0.4, 'nil'])
    fireEvent.change(screen.getByTestId('slot-z-hop-type'), { target: { value: '' } })
    expect(get().overrides).not.toHaveProperty(TYPE_KEY)
  })
})

describe('imports', () => {
  it("a project's per-filament lift reaches the overrides, and the dialog shows each slot's own", () => {
    // A 3MF project writes every value as text, one entry per filament, nil for a filament on the printer's value.
    const raw = { filament_z_hop: ['0.6', 'nil'], filament_z_hop_types: ['nil', 'Ramp Lift'] }
    const { values } = projectSettingChanges(raw, resolveConfig(get().easy, {}))
    expect(values[HEIGHT_KEY]).toEqual([0.6, 'nil'])
    expect(values[TYPE_KEY]).toEqual(['nil', 'Ramp Lift'])
    set({ overrides: values, slotDialog: 1 })
    mount()
    expect((screen.getByTestId('slot-z-hop') as HTMLInputElement).value).toBe('0.6')
    expect((screen.getByTestId('slot-z-hop-type') as HTMLSelectElement).value).toBe('')
    cleanup()
    set({ slotDialog: 2 })
    mount()
    expect((screen.getByTestId('slot-z-hop') as HTMLInputElement).value).toBe('')
    expect((screen.getByTestId('slot-z-hop-type') as HTMLSelectElement).value).toBe('Ramp Lift')
  })

  it("filament profiles keep each slot's own lift and leave the others on the printer's", () => {
    const out = perSlot([{ nozzle_temperature: [215] }, { filament_z_hop: [0.6], filament_z_hop_types: ['Normal Lift'] }])
    expect(out[HEIGHT_KEY]).toEqual(['nil', 0.6])
    expect(out[TYPE_KEY]).toEqual(['nil', 'Normal Lift'])
    expect(slotHeight(out, 2)).toBe(0.6)
    expect(slotType(out, 1)).toBeUndefined()
  })
})

describe('the slice request', () => {
  const handle = { id: 'a', hash: 'a', name: 'a', triangles: 1, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'a', slot: 1, triangles: 1 }] }
  const entry = { id: 'a', name: 'a', handle, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } as never
  beforeEach(() => set({ plate: [entry], resume: null, slice: { status: 'idle' }, calibration: {}, layerMarks: {} }))

  it("carries the slot's own Z hop height and type set in the dialog", async () => {
    set((s) => ({ overrides: withSlotValue(TYPE_KEY, withSlotValue(HEIGHT_KEY, s.overrides, 1, 1, 0.6), 1, 1, 'Ramp Lift') }))
    const requests: SliceRequest[] = []
    const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { slice: async (r: SliceRequest) => { requests.push(r); throw new Error('stop') }, loadParts: async () => handle } } as unknown as Host
    await slicePlate(host)
    expect(requests[0]!.config[HEIGHT_KEY]).toEqual([0.6])
    expect(requests[0]!.config[TYPE_KEY]).toEqual(['Ramp Lift'])
  })
})
