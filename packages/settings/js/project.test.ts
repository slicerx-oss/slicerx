// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { exportOrcaProfile, mergeConfigs } from './import'
import { importProject, parseXml } from './project'
import { loadProfile } from './testkit'

const printer = loadProfile('demo', 'Demo Printer 0.4 nozzle')
const filament = loadProfile('demo', 'Demo PLA')
const process = loadProfile('demo', '0.20mm Standard @Demo')

/** A project settings file shaped like the one a slicer writes: every section in one flat object. */
function projectSettings(): Record<string, unknown> {
  const parts = [
    exportOrcaProfile(process.config, { name: 'p', section: 'process' }),
    exportOrcaProfile(filament.config, { name: 'f', section: 'filament' }),
    exportOrcaProfile(printer.config, { name: 'm', section: 'printer' }),
  ]
  const flat: Record<string, unknown> = {}
  for (const p of parts) for (const [k, v] of Object.entries(p)) if (!['type', 'name', 'from', 'instantiation'].includes(k)) flat[k] = v
  return {
    ...flat,
    name: 'project_settings',
    from: 'project',
    version: '02.01.01.52',
    print_settings_id: '0.20mm Standard @Demo',
    printer_settings_id: 'Demo Printer 0.4 nozzle',
    filament_settings_id: ['Demo PLA', 'Demo PETG'],
    filament_colour: ['#FFFFFF', '#000000'],
    wipe_tower_x: ['15'],
    some_future_studio_key: '1',
  }
}

const MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="8">
    <metadata key="name" value="Keychain &amp; tag"/>
    <metadata key="extruder" value="2"/>
    <metadata key="brim_type" value="outer_only"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="Face"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="extruder" value="1"/>
      <metadata key="top_surface_pattern" value="monotonic"/>
    </part>
    <part id="2" subtype="modifier">
      <metadata key="name" value="Denser"/>
      <metadata key="sparse_infill_density" value="40%"/>
      <metadata key="made_up_setting" value="1"/>
    </part>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value="Keychain"/>
    <model_instance><metadata key="object_id" value="8"/></model_instance>
  </plate>
</config>`

const RANGES = `<?xml version="1.0" encoding="utf-8"?>
<objects>
 <object id="8">
  <range min_z="0.000" max_z="2.800">
   <option opt_key="layer_height">0.12</option>
   <option opt_key="wall_loops">4</option>
  </range>
 </object>
</objects>`

describe('importProject', () => {
  const r = importProject({ projectSettings: projectSettings(), modelSettings: MODEL, layerRanges: RANGES })

  it('reads the whole config across sections', () => {
    expect(r.config['layer_height']).toBe(0.2)
    expect(r.config['nozzle_temperature']).toEqual([220, 220])
    expect(r.config['printable_area']).toEqual([[0, 0], [256, 0], [256, 256], [0, 256]])
    expect(r.names).toEqual({ process: '0.20mm Standard @Demo', printer: 'Demo Printer 0.4 nozzle', filaments: ['Demo PLA', 'Demo PETG'], version: '02.01.01.52' })
  })

  it('keeps project level values apart from settings', () => {
    expect(r.extras['filament_colour']).toEqual(['#FFFFFF', '#000000'])
    expect(r.extras['wipe_tower_x']).toEqual(['15'])
    expect('filament_colour' in r.config).toBe(false)
    expect(r.unknownKeys).toEqual(['made_up_setting', 'some_future_studio_key'])
    expect(r.invalidKeys).toEqual([])
  })

  it('reads per object and per part overrides', () => {
    expect(r.objects).toHaveLength(1)
    const o = r.objects[0]
    expect(o).toMatchObject({ id: '8', name: 'Keychain & tag', extruder: 2, overrides: { brim_type: 'outer_only' } })
    expect(o?.parts.map((p) => [p.id, p.name, p.subtype, p.extruder])).toEqual([['1', 'Face', 'normal_part', 1], ['2', 'Denser', 'modifier', undefined]])
    expect(o?.parts[0]?.overrides).toEqual({ top_surface_pattern: 'monotonic' })
    expect(o?.parts[1]?.overrides).toEqual({ sparse_infill_density: 40 })
  })

  it('reads plates and layer ranges', () => {
    expect(r.plates).toEqual([{ id: '1', name: 'Keychain' }])
    expect(r.layerRanges).toEqual([{ objectId: '8', minZ: 0, maxZ: 2.8, overrides: { layer_height: 0.12, wall_loops: 4 } }])
  })

  it('works with the settings file alone', () => {
    const only = importProject({ projectSettings: projectSettings() })
    expect(only.objects).toEqual([])
    expect(only.config).toEqual(r.config)
  })

  it('merges to the same config as the separate profiles', () => {
    const merged = mergeConfigs(printer.config, filament.config, process.config)
    for (const [k, v] of Object.entries(merged)) if (k in r.config) expect(r.config[k], k).toEqual(v)
  })

  it('rejects a settings file that is not an object', () => {
    expect(() => importProject({ projectSettings: [] })).toThrow(TypeError)
    expect(() => importProject({ projectSettings: 'x' })).toThrow(TypeError)
  })
})

describe('parseXml', () => {
  it('reads attributes, text, self closing tags, comments and entities', () => {
    const t = parseXml('<?xml version="1.0"?><!-- c --><a x="1 &lt; 2"><b/><c k=\'v\'>hi &amp; bye</c></a>')
    const a = t.children[0]
    expect(a?.attrs).toEqual({ x: '1 < 2' })
    expect(a?.children.map((c) => c.name)).toEqual(['b', 'c'])
    expect(a?.children[1]).toMatchObject({ attrs: { k: 'v' }, text: 'hi & bye' })
  })
})
