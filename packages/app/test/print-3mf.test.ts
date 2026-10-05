// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The .gcode.3mf a Bambu Lab printer starts with `project_file`, part by part against what Orca 2.4.2 writes for
// an A1 and an A1 mini plate (bbs_3mf.cpp), and the Print sheet's send of it.
import { describe, expect, it, vi } from 'vitest'
import type { Host, JobFile, MeshHandle } from '@slicerx/contracts'
import { sha256Hex } from '../src/calibration/gcode'
import { md5Hex } from '../src/export/md5'
import { gcodeThumbnails, sliceMachine, withoutThumbnails, writeProject } from '../src/export/threemf'
import { unzipEntries } from '../src/export/import3mf'
import { unzipStored } from '../src/export/zip'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { matchSlots } from '../src/send/options'
import { refusalReason, sendToPrinter } from '../src/state/actions'
import { get, set, type PlateEntry, type PlateMeta } from '../src/state/store'

const dec = (b: Uint8Array | undefined) => new TextDecoder().decode(b)
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function obj(id: string, name: string, x: number): PlateEntry {
  const handle = { id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] } as MeshHandle
  return { id, name, handle, parts: [{ ...boxMesh(20, 20, 20), name: 'body', slot: 1 }], colors: ['#f2754e'], transform: compose({ position: [x, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
}

/** A two-object, two-filament plate as the engine writes it for a Bambu Lab printer. */
function gcode(x0 = 60): string {
  return [
    '; HEADER_BLOCK_START',
    '; model label id: 1,2',
    '; estimated first layer printing time (normal mode) = 6m 15s',
    '; HEADER_BLOCK_END',
    '; THUMBNAIL_BLOCK_START',
    `; thumbnail begin 48x48 ${PNG.length}`,
    `; ${PNG}`,
    '; thumbnail end',
    // The engine gives each size its own block, as Orca does.
    '; THUMBNAIL_BLOCK_END',
    '',
    '; THUMBNAIL_BLOCK_START',
    `; thumbnail begin 300x300 ${PNG.length}`,
    `; ${PNG.slice(0, 40)}`,
    `; ${PNG.slice(40)}`,
    '; thumbnail end',
    '; THUMBNAIL_BLOCK_END',
    '; start printing object, unique label id: 1',
    `G1 X${x0} Y60`,
    `G1 X${x0 + 20} Y80 E1`,
    '; stop printing object, unique label id: 1',
    '; start printing object, unique label id: 2',
    'G1 X100 Y60',
    'G1 X120 Y80 E1',
    '; stop printing object, unique label id: 2',
    '; filament used [mm] = 2403.83, 120.00',
    '; filament used [g] = 7.29, 0.36',
    '; total filament used [g] = 7.65',
    '; estimated printing time (normal mode) = 24m 47s',
    '',
  ].join('\n')
}

const A1 = {
  printer_model: 'Bambu Lab A1',
  nozzle_diameter: ['0.4'],
  printable_area: ['0x0', '256x0', '256x256', '0x256'],
  filament_type: ['PLA', 'PETG'],
  filament_colour: ['#f2754e', '#00AE42'],
  filament_ids: ['GFA00', 'GFG00'],
  enable_support: '0',
  layer_height: '0.2',
  timelapse_type: '0',
}

const plates: PlateMeta[] = [{ id: 'p1', name: 'Plate 1', objects: [obj('a', 'cube_a', 60), obj('b', 'cube_b', 100)], settings: { sequence: 'by-layer', bedType: 'textured-pei' } }]

describe('the .gcode.3mf for a Bambu Lab A1', () => {
  const files = unzipStored(writeProject({ plates, bed: { widthMm: 256, depthMm: 256 }, settings: A1, gcode: { 0: gcode() } }))

  it('has the parts Orca writes for a sliced plate', () => {
    expect([...files.keys()]).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        '_rels/.rels',
        '3D/3dmodel.model',
        'Metadata/model_settings.config',
        'Metadata/_rels/model_settings.config.rels',
        'Metadata/project_settings.config',
        'Metadata/slice_info.config',
        'Metadata/plate_1.gcode',
        'Metadata/plate_1.gcode.md5',
        'Metadata/plate_1.json',
        'Metadata/plate_1.png',
        'Metadata/plate_1_small.png',
      ]),
    )
    expect(dec(files.get('[Content_Types].xml'))).toContain('<Default Extension="png" ContentType="image/png"/>')
    expect(dec(files.get('_rels/.rels'))).toContain('Target="/Metadata/plate_1.png" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"')
    expect(dec(files.get('_rels/.rels'))).toContain('Target="/Metadata/plate_1_small.png" Id="rel-5"')
    expect(dec(files.get('Metadata/_rels/model_settings.config.rels'))).toContain('Target="/Metadata/plate_1.gcode" Id="rel-1" Type="http://schemas.bambulab.com/package/2021/gcode"')
  })

  it('checks the G-code with the MD5 in capitals, as Orca writes it', () => {
    expect(dec(files.get('Metadata/plate_1.gcode'))).toBe(withoutThumbnails(gcode()))
    expect(dec(files.get('Metadata/plate_1.gcode.md5'))).toBe(md5Hex(new TextEncoder().encode(withoutThumbnails(gcode()))).toUpperCase())
  })

  it('leaves the pictures out of the G-code the printer runs, as Orca does, and keeps them as plate_1.png', () => {
    const run = dec(files.get('Metadata/plate_1.gcode'))
    expect(run).not.toContain('THUMBNAIL_BLOCK')
    expect(run).not.toContain('thumbnail begin')
    expect(run.split('\n').slice(0, 5)).toEqual(['; HEADER_BLOCK_START', '; model label id: 1,2', '; estimated first layer printing time (normal mode) = 6m 15s', '; HEADER_BLOCK_END', '; start printing object, unique label id: 1'])
    expect(files.get('Metadata/plate_1.png')).toBeDefined()
    expect(withoutThumbnails('G1 X1\n')).toBe('G1 X1\n')
  })

  it('fills slice_info.config with the printer facts Orca writes for an A1', () => {
    const info = dec(files.get('Metadata/slice_info.config'))
    for (const line of [
      '<header_item key="X-BBL-Client-Type" value="slicer"/>',
      '<header_item key="X-BBL-Client-Version" value="02.06.00.51"/>',
      '<metadata key="index" value="1"/>',
      '<metadata key="extruder_type" value="0"/>',
      '<metadata key="nozzle_volume_type" value="0"/>',
      '<metadata key="printer_model_id" value="N2S"/>',
      '<metadata key="nozzle_diameters" value="0.4"/>',
      '<metadata key="timelapse_type" value="0"/>',
      '<metadata key="prediction" value="1487"/>',
      '<metadata key="weight" value="7.65"/>',
      '<metadata key="first_layer_time" value="375.000000"/>',
      '<metadata key="outside" value="false"/>',
      '<metadata key="support_used" value="false"/>',
      '<metadata key="label_object_enabled" value="true"/>',
      '<metadata key="enable_filament_dynamic_map" value="false"/>',
      '<metadata key="has_filament_switcher" value="false"/>',
      '<metadata key="filament_maps" value="1 1"/>',
      '<object identify_id="1" name="cube_a" skipped="false" />',
      '<object identify_id="2" name="cube_b" skipped="false" />',
      '<filament id="1" tray_info_idx="GFA00" type="PLA" color="#F2754E" used_m="2.40" used_g="7.29" group_id="0" nozzle_diameter="0.40" volume_type="Standard" used_for_object="true" used_for_support="false"/>',
      '<filament id="2" tray_info_idx="GFG00" type="PETG" color="#00AE42" used_m="0.12" used_g="0.36"',
      '<nozzle id="0" extruder_id="1" nozzle_diameter="0.4" volume_type="Standard"/>',
    ])
      expect(info).toContain(line)
  })

  it('gives each instance the id the G-code labels it with, and points the plate at its files', () => {
    const cfg = dec(files.get('Metadata/model_settings.config'))
    expect(cfg.match(/<metadata key="identify_id" value="(\d+)"\/>/g)).toEqual(['<metadata key="identify_id" value="1"/>', '<metadata key="identify_id" value="2"/>'])
    expect(cfg).toContain('<metadata key="gcode_file" value="Metadata/plate_1.gcode"/>')
    expect(cfg).toContain('<metadata key="thumbnail_file" value="Metadata/plate_1.png"/>')
    expect(cfg).toContain('<metadata key="pattern_bbox_file" value="Metadata/plate_1.json"/>')
  })

  it('writes plate_1.json with each object box under its label id', () => {
    const j = JSON.parse(dec(files.get('Metadata/plate_1.json'))) as Record<string, unknown>
    expect(j['bbox_all']).toEqual([60, 60, 120, 80])
    expect(j['bbox_objects']).toEqual([
      { area: 400, bbox: [60, 60, 80, 80], id: 1, layer_height: 0.2, name: 'cube_a' },
      { area: 400, bbox: [100, 60, 120, 80], id: 2, layer_height: 0.2, name: 'cube_b' },
    ])
    expect(j).toMatchObject({ bed_type: 'textured_plate', filament_colors: ['#F2754E', '#00AE42'], filament_ids: [0, 1], first_extruder: 0, first_layer_time: 375, is_seq_print: false, nozzle_diameter: 0.4, version: 2 })
  })

  it('takes the plate picture from the thumbnails in the G-code', () => {
    const shots = gcodeThumbnails(gcode())
    expect(shots.map((s) => `${s.w}x${s.h}`)).toEqual(['300x300', '48x48'])
    expect([...files.get('Metadata/plate_1.png')!.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })
})

describe('the .gcode.3mf for a Bambu Lab A1 mini', () => {
  const mini = { ...A1, printer_model: 'Bambu Lab A1 mini', printable_area: ['0x0', '180x0', '180x180', '0x180'] }

  it('names the A1 mini by its model id', () => {
    expect(sliceMachine(mini).printerModelId).toBe('N1')
    const info = dec(unzipStored(writeProject({ plates, bed: { widthMm: 180, depthMm: 180 }, settings: mini, gcode: { 0: gcode() } })).get('Metadata/slice_info.config'))
    expect(info).toContain('<metadata key="printer_model_id" value="N1"/>')
    expect(info).toContain('<metadata key="outside" value="false"/>')
  })

  it('says when a toolpath leaves the bed', () => {
    const info = dec(unzipStored(writeProject({ plates, bed: { widthMm: 180, depthMm: 180 }, settings: mini, gcode: { 0: gcode(170) } })).get('Metadata/slice_info.config'))
    expect(info).toContain('<metadata key="outside" value="true"/>')
  })

  it('reads the resolved config shapes too', () => {
    const m = sliceMachine({ printer_model: 'Bambu Lab A1 mini', nozzle_diameter: [0.4], printable_area: [[0, 0], [180, 0], [180, 180], [0, 180]], extruder_type: ['Direct Drive'], nozzle_volume_type: ['Standard'] })
    expect(m).toMatchObject({ printerModelId: 'N1', nozzleDiameters: [0.4], extruderTypes: [0], nozzleVolumeTypes: [0], printableArea: [[0, 0], [180, 0], [180, 180], [0, 180]] })
  })
})

describe('the Print sheet on a Bambu Lab printer', () => {
  const bambu = { id: 'a1', name: 'A1', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan', nozzleCount: 1 } as never

  it('sends the plate as a .gcode.3mf and binds the start to its bytes', async () => {
    const uploads: JobFile[] = []
    const starts: { name: string; sha256?: string }[] = []
    const printers = {
      status: async () => ({ state: 'idle', slots: [] }),
      upload: async (printerId: string, file: JobFile) => {
        uploads.push(file)
        return { printerId, path: file.name, name: file.name, sha256: file.sha256 }
      },
      start: async (file: { name: string; sha256?: string }) => void starts.push(file),
    }
    const approvals = { register: async () => undefined, grant: async (id: string) => ({ requestId: id }), deny: async () => undefined }
    const text = gcode()
    const blob = new Blob([text], { type: 'text/x-gcode' })
    const host = { kind: 'web', printers, approvals, slicer: { exportGcode: async () => ({ blob, bytes: blob.size, sha256: 'x' }) } } as unknown as Host
    set({ slice: { status: 'done', stale: false, result: { id: 'r1', layerCount: 100, warnings: [], stats: { timeS: 1487, filamentG: [7.29], filamentMm: [2403], cost: 0, toolChanges: 0 } } } as never, plate: [], approval: null, printSheet: null })
    const done = sendToPrinter(host, bambu)
    await vi.waitFor(() => expect(get().printSheet?.check).toBeTruthy(), { timeout: 5000 })
    const ask = get().printSheet!
    expect(ask.ending).toBe('.gcode.3mf')
    expect(ask.name.endsWith('.gcode.3mf')).toBe(true)
    ask.resolve({ options: {}, start: true, name: 'cube.gcode.3mf' })
    await done
    expect(uploads).toHaveLength(1)
    expect(uploads[0]!.kind).toBe('gcode.3mf')
    expect(uploads[0]!.name).toBe('cube.gcode.3mf')
    expect(uploads[0]!.sha256).toBe(await sha256Hex(uploads[0]!.data))
    expect(ask.check!.sha256).toBe(uploads[0]!.sha256)
    const inside = await unzipEntries(new Uint8Array(uploads[0]!.data))
    expect(dec(inside.get('Metadata/plate_1.gcode'))).toBe(withoutThumbnails(text))
    expect(starts).toEqual([expect.objectContaining({ name: 'cube.gcode.3mf', sha256: uploads[0]!.sha256 })])
  })
})

describe('slot choice on a printer that follows it', () => {
  it('starts each filament on a loaded slot of its material, closest color first', () => {
    const fil = [
      { index: 1, type: 'PLA', color: '#ffffff' },
      { index: 2, type: 'PLA', color: '#000000' },
      { index: 3, type: 'PETG', color: '#ff0000' },
    ]
    const slots = [
      { id: 'A1', material: 'PLA Basic', color: '#101010' },
      { id: 'A2', material: 'PLA', color: '#f0f0f0' },
      { id: 'A3', material: 'PLA', color: '#ffffff' },
      { id: 'A4' },
      { id: '1', material: 'PETG HF', color: '#ee0000' },
    ]
    expect(matchSlots(fil, slots)).toEqual({ 1: 'A3', 2: 'A1', 3: '1' })
  })

  it('leaves a filament no loaded slot matches for the person to pick', () => {
    expect(matchSlots([{ index: 1, type: 'TPU', color: '#000000' }], [{ id: 'A1', material: 'PLA', color: '#000000' }])).toEqual({})
  })
})

describe('a refused project start', () => {
  const bambu = { id: 'a1', name: 'A1', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan', nozzleCount: 1 } as never

  function hub() {
    const calls: { file: JobFile; opts: Record<string, unknown> }[] = []
    const printers = {
      status: async () => ({ state: 'idle', slots: [] }),
      bed: { state: async () => ({ state: 'clear', askOnPrint: false }) },
      printLocal: async (_id: string, file: JobFile, opts: Record<string, unknown>) => {
        calls.push({ file, opts })
        if (calls.length === 1) throw Object.assign(new Error('printer a1 refused the print: MD5 verify failed'), { code: 'refused' })
        return { started: true }
      },
    }
    const text = gcode()
    const blob = new Blob([text], { type: 'text/x-gcode' })
    const approvals = { register: async () => undefined, grant: async (id: string) => ({ requestId: id }), deny: async () => undefined }
    const host = { kind: 'web', printers, approvals, slicer: { exportGcode: async () => ({ blob, bytes: blob.size, sha256: 'x' }) } } as unknown as Host
    return { calls, host, text }
  }

  async function refused(h: ReturnType<typeof hub>) {
    set({ slice: { status: 'done', stale: false, result: { id: 'r1', layerCount: 100, warnings: [], stats: { timeS: 1487, filamentG: [7.29], filamentMm: [2403], cost: 0, toolChanges: 0 } } } as never, plate: [], approval: null, printSheet: null })
    const done = sendToPrinter(h.host, bambu)
    await vi.waitFor(() => expect(get().printSheet?.check).toBeTruthy(), { timeout: 5000 })
    get().printSheet!.resolve({ options: { bedLeveling: true }, start: true, name: 'cube.gcode.3mf', slotMap: { 1: 'A2' } })
    await vi.waitFor(() => expect(get().printSheet?.refusal).toBeTruthy(), { timeout: 5000 })
    return { done }
  }

  it('opens the sheet again with the reason, keeps the choices, and sends plain G-code only on that click', async () => {
    const h = hub()
    const { done } = await refused(h)
    const ask = get().printSheet!
    expect(ask.refusal!.reason).toBe('MD5 verify failed')
    expect(ask.refusal!.last.slotMap).toEqual({ 1: 'A2' })
    expect(ask.refusal!.plainSha256).toBe(await sha256Hex(new TextEncoder().encode(h.text).buffer as ArrayBuffer))
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.file.kind).toBe('gcode.3mf')
    ask.resolve({ options: { bedLeveling: true }, start: true, name: 'cube.gcode', plainGcode: true })
    await done
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]!.file).toMatchObject({ name: 'cube.gcode', kind: 'gcode', sha256: ask.refusal!.plainSha256 })
    expect(h.calls[1]!.opts['slotMap']).toBeUndefined()
  })

  it('sends nothing more when the person closes the sheet', async () => {
    const h = hub()
    const { done } = await refused(h)
    get().printSheet!.resolve(null)
    await done
    expect(h.calls).toHaveLength(1)
  })

  it('reads the reason out of the hub error', () => {
    expect(refusalReason(Object.assign(new Error('printer x refused the print: Not enough space'), { code: 'refused' }))).toBe('Not enough space')
    expect(refusalReason(Object.assign(new Error('nope'), { code: 'protocol' }))).toBeNull()
  })
})

const H2D = {
  printer_model: 'Bambu Lab H2D',
  nozzle_diameter: ['0.4', '0.4'],
  printable_area: ['0x0', '350x0', '350x320', '0x320'],
  filament_type: ['PLA', 'PLA'],
  filament_colour: ['#FF6A13', '#0A2989'],
  filament_ids: ['GFA00', 'GFA00'],
  enable_support: '0',
  layer_height: '0.2',
}

/** The engine's G-code for the plate with the configuration block lines the map comes from. */
const mapped = (lines: string[]) => gcode().replace('; HEADER_BLOCK_END', `; HEADER_BLOCK_END\n; CONFIG_BLOCK_START\n${lines.join('\n')}\n; CONFIG_BLOCK_END`)

describe('the filament map of a Bambu Lab H2D', () => {
  it('writes the map the slicer printed with, as Bambu Studio does: per plate and in slice_info, each filament in its nozzle', () => {
    const files = unzipStored(writeProject({ plates, bed: { widthMm: 350, depthMm: 320 }, settings: H2D, gcode: { 0: mapped(['; filament_map = 2,1', '; filament_nozzle_map = 1,0']) } }))
    const info = dec(files.get('Metadata/slice_info.config'))
    expect(info).toContain('<metadata key="filament_maps" value="2 1"/>')
    expect(info).toContain('<filament id="1" tray_info_idx="GFA00" type="PLA" color="#FF6A13" used_m="2.40" used_g="7.29" group_id="1" nozzle_diameter="0.40" volume_type="Standard"')
    expect(info).toContain('<filament id="2" tray_info_idx="GFA00" type="PLA" color="#0A2989" used_m="0.12" used_g="0.36" group_id="0"')
    expect(info).toContain('<nozzle id="0" extruder_id="1" nozzle_diameter="0.4" volume_type="Standard"/>\n    <nozzle id="1" extruder_id="2" nozzle_diameter="0.4" volume_type="Standard"/>')
    const model = dec(files.get('Metadata/model_settings.config'))
    expect(model).toContain('<metadata key="filament_map_mode" value="Auto For Flush"/><metadata key="filament_maps" value="2 1"/>')
  })

  it('keeps a map set by hand, sliced or not', () => {
    const manual: PlateMeta[] = [{ ...plates[0]!, settings: { sequence: 'by-layer', nozzleMap: [1, 1] } }]
    const sliced = unzipStored(writeProject({ plates: manual, bed: { widthMm: 350, depthMm: 320 }, settings: H2D, gcode: { 0: mapped(['; filament_map = 1,1', '; filament_map_mode = Manual']) } }))
    expect(dec(sliced.get('Metadata/model_settings.config'))).toContain('<metadata key="filament_map_mode" value="Manual"/><metadata key="filament_maps" value="1 1"/>')
    expect(dec(sliced.get('Metadata/slice_info.config'))).toContain('<metadata key="filament_maps" value="1 1"/>')
    const project = unzipStored(writeProject({ plates: manual, bed: { widthMm: 350, depthMm: 320 }, settings: H2D }))
    expect(dec(project.get('Metadata/model_settings.config'))).toContain('<metadata key="filament_map_mode" value="Manual"/><metadata key="filament_maps" value="1 1"/>')
  })

  it('writes no map for a printer with one nozzle', () => {
    const files = unzipStored(writeProject({ plates, bed: { widthMm: 256, depthMm: 256 }, settings: A1, gcode: { 0: gcode() } }))
    expect(dec(files.get('Metadata/model_settings.config'))).not.toContain('filament_map_mode')
  })
})
