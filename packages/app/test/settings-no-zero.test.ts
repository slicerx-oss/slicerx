// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings that make no sense at 0 (a flow ratio, a layer height, a diameter, a clearance): the app never stores 0
// for them. A settings field that is given 0 keeps to the setting's lower limit, as every number field does, and a
// client's project settings edit is refused with the setting's usual range message. Printer settings stay out of a
// client's edit, so for those the field and the app's value check are what hold. A project file that holds 0 opens
// with the value as the file has it, as before: the open never changes the settings a file holds.
import type { PrintConfig, SettingValue } from '@slicerx/contracts'
import { checkValues } from '@slicerx/settings'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { SETTINGS } from '../src/adapters/settings'
import { runCall } from '../src/app-link/methods'
import { readProject } from '../src/export/import3mf'
import { zip } from '../src/export/zip'
import { get, set } from '../src/state/store'
import { Field } from '../src/workspaces/prepare/expert-settings'

/** Each setting, whether it holds one value per filament or extruder, and the message its 0 is refused with. */
const NO_ZERO: { key: string; list: boolean; printer: boolean; message: string }[] = [
  { key: 'bridge_flow', list: false, printer: false, message: 'Bridge flow ratio is 0, outside 0.01 to 2.' },
  { key: 'internal_bridge_flow', list: false, printer: false, message: 'Internal bridge flow ratio is 0, outside 0.01 to 2.' },
  { key: 'layer_height', list: false, printer: false, message: 'Layer height is 0; it must be at least 0.01 mm.' },
  { key: 'initial_layer_print_height', list: false, printer: false, message: 'First layer height is 0; it must be at least 0.01 mm.' },
  { key: 'filament_diameter', list: true, printer: false, message: 'Filament diameter is 0; it must be at least 0.01 mm.' },
  { key: 'filament_flow_ratio', list: true, printer: false, message: 'Flow ratio is 0, outside 0.01 to 2.' },
  { key: 'nozzle_diameter', list: true, printer: true, message: 'Nozzle diameter is 0, outside 0.01 to 100 mm.' },
  { key: 'nozzle_height', list: false, printer: true, message: 'Nozzle height is 0; it must be at least 0.01 mm.' },
  { key: 'extruder_clearance_height_to_lid', list: false, printer: true, message: 'Extruder clearance height to lid is 0; it must be at least 0.01 mm.' },
  { key: 'extruder_clearance_height_to_rod', list: false, printer: true, message: 'Extruder clearance height to rod is 0; it must be at least 0.01 mm.' },
  { key: 'extruder_clearance_radius', list: false, printer: true, message: 'Extruder clearance radius is 0; it must be at least 0.01 mm.' },
]

let root: Root | null = null
let el: HTMLElement | null = null
beforeEach(() => set({ overrides: { wall_loops: 3 }, plate: [], plates: [], activePlate: 'plate', plateLoading: false, historyEdit: null, rollback: null, dragging: false, liveEdit: false, slice: { status: 'idle' } }))
afterEach(() => {
  if (root) flushSync(() => root!.unmount())
  el?.remove()
  root = null
  el = null
  set({ overrides: {} })
})

/** Types `text` into the setting's field and leaves it, as a person does; returns every value the field set. */
function typeInto(key: string, text: string): (SettingValue | undefined)[] {
  const def = SETTINGS.find((d) => d.key === key)!
  const sets: (SettingValue | undefined)[] = []
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  flushSync(() => root!.render(createElement(Field, { def, value: def.default as SettingValue, overridden: false, onSet: (_k: string, v: SettingValue | undefined) => sets.push(v) })))
  const input = el.querySelector('input')!
  flushSync(() => {
    input.focus()
    input.value = text
    input.blur()
  })
  return sets
}

describe('a setting that cannot be 0', () => {
  it.each(NO_ZERO)('$key is never stored as 0', async ({ key, list, printer, message }) => {
    // The field keeps to the lower limit.
    expect(typeInto(key, '0')).toEqual([list ? [0.01] : 0.01])
    // The app's value check names the usual range.
    const zero = list ? [0] : 0
    expect(checkValues({ [key]: zero } as PrintConfig).filter((i) => i.code === 'out_of_range').map((i) => i.message)).toEqual([message])
    // A client's edit of a print or filament setting is refused with that message and changes nothing.
    if (!printer) {
      const before = get().overrides
      await expect(runCall('project.set_overrides', { changes: { [key]: zero } })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining(message) })
      expect(get().overrides).toBe(before)
    }
  })
})

describe('a project file that holds 0 for one of them', () => {
  it('opens with the value as the file has it', async () => {
    const MODEL = '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" name="box" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="20" y="0" z="0"/><vertex x="0" y="20" z="0"/><vertex x="0" y="0" z="20"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>'
    const settings = Object.fromEntries(NO_ZERO.map(({ key, list }) => [key, list ? ['0'] : '0']))
    const p = await readProject(zip([{ name: '3D/3dmodel.model', data: MODEL }, { name: 'Metadata/project_settings.config', data: JSON.stringify(settings) }]), { widthMm: 256, depthMm: 256 })
    expect(p.settingsNote).toBeUndefined()
    for (const { key, list } of NO_ZERO) expect(p.settings[key], key).toEqual(list ? ['0'] : '0')
  })
})
