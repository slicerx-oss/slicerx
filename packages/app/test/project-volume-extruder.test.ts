// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The filament keys a saved project gives its modifiers and other volumes. Other slicers print the region inside a
// modifier in the modifier's `extruder` when it is above 0, so a modifier the person gave no filament must not carry
// one, or the region prints in filament 1 there.
import { describe, expect, it } from 'vitest'
import type { MeshHandle } from '@slicerx/contracts'
import { projectFiles as fileOf, writeProject as writeFile, type ObjectInput, type VolumeInput } from '@slicerx/threemf'
import { readProject } from '../src/export/import3mf'
import { projectFiles, writeProject } from '../src/export/threemf'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import type { PlateEntry, PlateMeta, PlateVolumeEntry, VolumeRole } from '../src/state/store'

const bed = { widthMm: 256, depthMm: 256 }
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })
const at = (x: number, y: number, z: number) => compose({ position: [x, y, z], rotation: [0, 0, 0], scale: [1, 1, 1] })

const part = (name: string, slot: number) => ({ ...boxMesh(10, 10, 2), name, slot })
const volume = (id: string, role: VolumeRole, settings?: PlateVolumeEntry['settings']): PlateVolumeEntry => ({ id, name: id, role, handle: handle(id), part: boxMesh(12, 6, 3), local: at(0, 3, 0), ...(settings ? { settings } : {}) })

function entry(parts: ReturnType<typeof part>[], volumes: PlateVolumeEntry[], more: Partial<PlateEntry> = {}): PlateEntry {
  return { id: 'o', name: 'Box', handle: handle('o'), parts, colors: parts.map(() => '#bd93f9'), transform: at(100, 100, 0), ...(volumes.length ? { volumes } : {}), ...more }
}
const plate = (e: PlateEntry): PlateMeta[] => [{ id: 'p1', name: 'Plate 1', objects: [e], settings: { sequence: 'by-layer' } }]
const configOf = (files: { name: string; data: unknown }[]) => String(files.find((f) => f.name === 'Metadata/model_settings.config')!.data)

interface Keys {
  object: number | undefined
  parts: { subtype: string; extruder: number | undefined }[]
}

/** Each object's `extruder` keys in a written model_settings.config, the object's and each part's in order. */
function keysOf(cfg: string): Keys[] {
  const ext = (s: string) => {
    const m = /<metadata key="extruder" value="(\d+)"\/>/.exec(s)
    return m ? Number(m[1]) : undefined
  }
  return [...cfg.matchAll(/<object id="\d+">(.*?)<\/object>/g)].map(([, body]) => ({
    object: ext(body!.split('<part ')[0]!),
    parts: [...body!.matchAll(/<part id="\d+" subtype="([a-z_]+)">(.*?)<\/part>/g)].map(([, subtype, inner]) => ({ subtype: subtype!, extruder: ext(inner!) })),
  }))
}

/**
 * The filament each region prints in when other slicers open the file: one volume prints in the object's key (1 when
 * it is absent or 0); two or more give each normal part its own key, else the object's, else 1. A modifier with a key
 * above 0 prints its region in that filament, without one (or with 0) it changes nothing. Keys on negative parts,
 * blockers and enforcers change no filament.
 */
function printedBy(k: Keys): { parts: number[]; modifiers: (number | null)[] } {
  const own = (n: number | undefined) => (n !== undefined && n > 0 ? n : undefined)
  const normal = k.parts.filter((p) => p.subtype === 'normal_part')
  const parts = k.parts.length === 1 ? [own(k.object) ?? 1] : normal.map((p) => own(p.extruder) ?? own(k.object) ?? 1)
  const modifiers = k.parts.filter((p) => p.subtype === 'modifier_part').map((p) => own(p.extruder) ?? null)
  return { parts, modifiers }
}

describe('filament keys on extra volumes in a saved project', () => {
  it('a modifier with no filament on an object on filament 2 leaves its region in filament 2', async () => {
    const pl = plate(entry([part('Body', 2)], [volume('Modifier 1', 'modifier', { wall_loops: 3 })]))
    const [k] = keysOf(configOf(projectFiles({ plates: pl, bed, settings: {} })))
    expect(k!.parts.map((p) => p.extruder)).toEqual([2, 0])
    expect(printedBy(k!)).toEqual({ parts: [2], modifiers: [null] })
    // Read back with our own reader: the modifier takes the object's filament, not filament 1.
    const back = (await readProject(writeProject({ plates: pl, bed, settings: {} }), bed)).plates[0]!.objects[0]!
    expect(back.parts.map((p) => p.slot)).toEqual([2])
    expect(back.volumes.map((v) => [v.role, v.part.slot])).toEqual([['modifier', 2]])
  })

  it('a modifier with no filament across two parts on filaments 1 and 2 keeps each part in its own', () => {
    const pl = plate(entry([part('Left', 1), part('Right', 2)], [volume('Modifier 1', 'modifier')]))
    const [k] = keysOf(configOf(projectFiles({ plates: pl, bed, settings: {} })))
    expect(k!.object).toBe(1)
    expect(k!.parts.map((p) => p.extruder)).toEqual([1, 2, 0])
    expect(printedBy(k!)).toEqual({ parts: [1, 2], modifiers: [null] })
  })

  it('a part moved to another filament keeps it, and its modifier carries none', () => {
    const pl = plate(entry([part('Body', 1)], [volume('Modifier 1', 'modifier', { sparse_infill_density: '40%' })], { slotOverrides: { Body: 3 } }))
    const [k] = keysOf(configOf(projectFiles({ plates: pl, bed, settings: {} })))
    expect(k!.object).toBe(3)
    expect(k!.parts.map((p) => p.extruder)).toEqual([3, 0])
    expect(printedBy(k!)).toEqual({ parts: [3], modifiers: [null] })
  })

  it('negative parts, blockers and enforcers carry no filament', () => {
    const pl = plate(entry([part('Body', 3)], [volume('Negative 1', 'negative'), volume('Blocker 1', 'support_blocker'), volume('Enforcer 1', 'support_enforcer')]))
    const [k] = keysOf(configOf(projectFiles({ plates: pl, bed, settings: {} })))
    expect(k!.parts.map((p) => [p.subtype, p.extruder])).toEqual([
      ['normal_part', 3],
      ['negative_part', 0],
      ['support_blocker', 0],
      ['support_enforcer', 0],
    ])
    expect(printedBy(k!)).toEqual({ parts: [3], modifiers: [] })
  })

  it('a modifier set to a filament keeps it, and only a modifier', async () => {
    const vol = (role: VolumeInput['role']): VolumeInput => ({ name: role, role, part: { ...boxMesh(12, 6, 3), name: role, slot: 1 }, local: at(0, 3, 0), slot: 3 })
    const obj: ObjectInput = { id: 'o', name: 'Box', parts: [part('Body', 2)], transform: at(100, 100, 0), volumes: [vol('modifier'), vol('negative')] }
    const input = { plates: [{ id: 'p1', name: 'Plate 1', objects: [obj], settings: { sequence: 'by-layer' as const } }], bed, settings: {}, application: 'SlicerX' }
    const [k] = keysOf(configOf(fileOf(input)))
    expect(k!.parts.map((p) => p.extruder)).toEqual([2, 3, 0])
    expect(printedBy(k!)).toEqual({ parts: [2], modifiers: [3] })
    const back = (await readProject(writeFile(input), bed)).plates[0]!.objects[0]!
    expect(back.volumes.map((v) => [v.role, v.part.slot])).toEqual([['modifier', 3], ['negative', 2]])
  })

  it('objects without extra volumes keep the keys they had', () => {
    const one = keysOf(configOf(projectFiles({ plates: plate(entry([part('Body', 2)], [])), bed, settings: {} })))
    expect(one).toEqual([{ object: 2, parts: [{ subtype: 'normal_part', extruder: 2 }] }])
    const moved = keysOf(configOf(projectFiles({ plates: plate(entry([part('Body', 1)], [], { slotOverrides: { Body: 3 } })), bed, settings: {} })))
    expect(moved).toEqual([{ object: 3, parts: [{ subtype: 'normal_part', extruder: 3 }] }])
    const two = keysOf(configOf(projectFiles({ plates: plate(entry([part('Left', 2), part('Right', 1)], [])), bed, settings: {} })))
    expect(two).toEqual([{ object: 2, parts: [{ subtype: 'normal_part', extruder: 2 }, { subtype: 'normal_part', extruder: 1 }] }])
  })
})
