// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Bambu Studio project writes -1 where Bambu Studio picks the value itself (raft_first_layer_expansion,
// tree_support_wall_count). It opens with our value for that, and a value the engine still refuses is dropped at the
// slice with a note, so the plate slices instead of failing.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle, SettingValue, SliceRequest } from '@slicerx/contracts'
import { resolveConfig } from '../src/adapters/config'
import { entryWithout, projectSettingChanges, refusedSetting } from '../src/export/project-settings'
import { zip } from '../src/export/zip'
import { openModelBytes, slicePlate } from '../src/state/actions'
import { profileReady } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [10, 10, 10], openEdges: 0, parts: [] })

const MODEL = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="10" z="0"/><vertex x="0" y="0" z="10"/></vertices><triangles><triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="1" v2="2" v3="3"/><triangle v1="0" v2="3" v3="2"/></triangles></mesh></object></resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 128 128 0"/></build></model>`

/** The -1s a Bambu Studio A1 mini project carries, as Bambu Studio writes them (every value a string). */
const BAMBU = {
  printer_model: 'Bambu Lab A1 mini',
  enable_support: '1',
  raft_layers: '2',
  raft_first_layer_expansion: '-1',
  tree_support_wall_count: '-1',
  support_interface_bottom_layers: '-1',
  prime_tower_brim_width: '-1',
  ironing_fan_speed: ['-1'],
  filament_ramming_volumetric_speed: ['-1'],
  filament_tower_interface_print_temp: ['-1'],
}

function project(extra: Record<string, unknown> = {}): ArrayBuffer {
  const bytes = zip([
    { name: '3D/3dmodel.model', data: MODEL },
    { name: 'Metadata/project_settings.config', data: JSON.stringify({ ...BAMBU, ...extra }) },
  ])
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

const cfgOf = (r: SliceRequest): Record<string, SettingValue> => r.config as Record<string, SettingValue>

/** The engine's own range checks for the keys here (packages/core/src/config.rs), in its message form. */
function engineRefusal(c: Record<string, SettingValue>): string | null {
  for (const key of ['raft_expansion', 'raft_first_layer_expansion']) {
    const v = Number(c[key] ?? 0)
    if (!(v >= 0 && v <= 100)) return `config key ${key}: ${v} is outside 0 to 100`
  }
  const walls = Number(c['tree_support_wall_count'] ?? 0)
  if (!(walls >= 0 && walls <= 20)) return 'config key tree_support_wall_count: unexpected value'
  return null
}

/** A host whose slice records each request, refuses what the engine refuses, and stops after anything else. */
function engine(): { host: Host; requests: SliceRequest[] } {
  const requests: SliceRequest[] = []
  const slice = async (r: SliceRequest) => {
    requests.push(r)
    throw new Error(engineRefusal(cfgOf(r)) ?? 'stop')
  }
  const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { slice, loadParts: async (name: string) => handle(name) } } as unknown as Host
  return { host, requests }
}

beforeEach(async () => {
  set((s) => ({ plate: [], plates: s.plates.map((p) => ({ ...p, objects: [] })), overrides: {}, projectSettings: null, projectGcode: null, resume: null, calibration: {}, layerMarks: {}, slice: { status: 'idle' }, toast: null }))
  await profileReady()
})

describe("a Bambu Studio project's -1 values", () => {
  it('open as our value for auto, and the plate slices with no refusal', async () => {
    const { host, requests } = engine()
    await openModelBytes(host, 'a1-mini.3mf', project())
    expect(get().plate).toHaveLength(1)
    const cfg = resolveConfig(get().easy, get().overrides) as Record<string, SettingValue>
    expect(cfg['raft_first_layer_expansion']).toBe(2)
    expect(cfg['tree_support_wall_count']).toBe(0)
    expect(cfg['raft_layers']).toBe(2)
    await slicePlate(host, { auto: true })
    expect(requests).toHaveLength(1)
    expect(engineRefusal(cfgOf(requests[0]!))).toBeNull()
    expect(get().slice).toEqual({ status: 'error', message: 'stop' })
  })

  it('open as our value for auto on the printer the project is for, where its process is taken whole', async () => {
    // A P1S project that lists what it changed: the -1s are not in the list, so only the whole process brings them.
    const p1s = {
      printer_model: 'Bambu Lab P1S',
      printer_settings_id: 'Bambu Lab P1S 0.4 nozzle',
      printer_variant: '0.4',
      nozzle_diameter: ['0.4'],
      inherits_group: ['0.12mm Fine @BBL X1C', ''],
      different_settings_to_system: ['enable_support;support_type', ''],
      raft_layers: '0',
    }
    const { host, requests } = engine()
    await openModelBytes(host, 'p1s.3mf', project(p1s))
    expect(get().projectPrinter?.profileId).toBe('bambu-p1s')
    expect(get().toast?.text).toMatch(/^Opened as P1S 0\.4 mm from the project\./)
    const cfg = resolveConfig(get().easy, get().overrides) as Record<string, SettingValue>
    expect(cfg['enable_support']).toBe(true)
    expect(cfg['raft_first_layer_expansion']).toBe(2)
    expect(cfg['tree_support_wall_count']).toBe(0)
    await slicePlate(host, { auto: true })
    expect(requests).toHaveLength(1)
    expect(engineRefusal(cfgOf(requests[0]!))).toBeNull()
    expect(get().slice).toEqual({ status: 'error', message: 'stop' })
  })

  it('a value the engine still refuses is dropped with a note, and the plate slices with the profile value', async () => {
    const { host, requests } = engine()
    await openModelBytes(host, 'a1-mini.3mf', project({ raft_expansion: '-3' }))
    expect(get().overrides['raft_expansion']).toBe(-3)
    await slicePlate(host, { auto: true })
    expect(requests).toHaveLength(2)
    expect(cfgOf(requests[0]!)['raft_expansion']).toBe(-3)
    const profile = resolveConfig(get().easy, {}) as Record<string, SettingValue>
    expect(cfgOf(requests[1]!)['raft_expansion']).toBe(profile['raft_expansion'])
    expect(engineRefusal(cfgOf(requests[1]!))).toBeNull()
    expect(get().overrides).not.toHaveProperty('raft_expansion')
    expect(get().projectSettings?.keys).not.toContain('raft_expansion')
    expect(get().toast?.text).toMatch(/^Setting not imported from a1-mini\.3mf: Raft expansion \(-3 is outside 0 to 100\)/)
    expect(get().slice).toEqual({ status: 'error', message: 'stop' })
  })

  it('a refusal over a key the person set is shown, not dropped', async () => {
    const { host, requests } = engine()
    await openModelBytes(host, 'a1-mini.3mf', project())
    set((s) => ({ overrides: { ...s.overrides, raft_expansion: -3 } }))
    await slicePlate(host, { auto: true })
    expect(requests).toHaveLength(1)
    expect(get().slice).toEqual({ status: 'error', message: 'config key raft_expansion: -3 is outside 0 to 100' })
    expect(get().overrides['raft_expansion']).toBe(-3)
  })
})

describe('helpers', () => {
  it('reads the key and reason out of an engine refusal', () => {
    expect(refusedSetting('config key raft_first_layer_expansion: -1 is outside 0 to 100')).toEqual({ key: 'raft_first_layer_expansion', reason: '-1 is outside 0 to 100' })
    expect(refusedSetting('Error: config key wall_loops: unexpected value')).toEqual({ key: 'wall_loops', reason: 'unexpected value' })
    expect(refusedSetting('the plate has no printable geometry')).toBeNull()
  })

  it('takes a key out of part and modifier settings only', () => {
    const e = { partSettings: { body: { raft_expansion: -3, wall_loops: 3 } }, volumes: [{ settings: { raft_expansion: -3 } }, { name: 'plain' }] } as never
    expect(entryWithout(e, 'raft_expansion')).toEqual({ partSettings: { body: { wall_loops: 3 } }, volumes: [{ settings: {} }, { name: 'plain' }] })
    expect(entryWithout(e, 'sparse_infill_density')).toBe(e)
  })

  it('maps the -1s in the project settings', () => {
    const { values } = projectSettingChanges({ raft_first_layer_expansion: '-1', tree_support_wall_count: '-1', raft_layers: '2' }, resolveConfig(get().easy, {}))
    expect(values['raft_first_layer_expansion'] ?? 2).toBe(2)
    expect(values['tree_support_wall_count'] ?? 0).toBe(0)
    expect(values['raft_layers']).toBe(2)
  })
})
