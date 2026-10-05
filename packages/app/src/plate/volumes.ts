// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Extra volumes of an object: negative volumes cut material out of every layer, support blockers keep
// support out, support enforcers put support in at any angle. A volume belongs to an object and moves
// with it; its own placement is kept in the object's coordinates. Modifier volumes with their own
// settings wait on the slicer.
import type { MeshHandle, MeshPart, PlateVolume, SettingValue } from '@slicerx/contracts'
import { get, markStale, set, type PlateEntry, type PlateVolumeEntry, type VolumeRole } from '../state/store'
import { selectedEntry } from './edit'
import { bake } from './mesh-ops'
import { primitive, type PrimitiveShape } from './mesh-ops'
import { bounds, compose, decompose, identity, multiply, type Mat4, type Trs, type Vec3 } from './transform'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

export const ROLE_LABEL: Record<VolumeRole, string> = {
  negative: 'Negative volume',
  support_blocker: 'Support blocker',
  support_enforcer: 'Support enforcer',
  modifier: 'Modifier',
}

let seq = 0
const newId = () => `vol_${Date.now().toString(36)}${(++seq).toString(36)}`
const at = (position: Vec3): Mat4 => compose({ position, rotation: [0, 0, 0], scale: [1, 1, 1] })

function centered(part: MeshPart): MeshPart {
  const b = bounds([part], identity())
  if (!b) return part
  const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]
  return bake(part, at([-c[0], -c[1], -c[2]]))
}

function update(objectId: string, fn: (v: PlateVolumeEntry[]) => PlateVolumeEntry[]): void {
  set({ plate: get().plate.map((p) => (p.id === objectId ? { ...p, volumes: fn(p.volumes ?? []) } : p)) })
  markStale()
}

function need(id?: string): PlateEntry {
  const e = id ? get().plate.find((p) => p.id === id) : selectedEntry()
  if (!e) throw new Error('Select an object first.')
  return e
}

/** Object's own bounds center and size, so a new volume lands inside it at a sensible size. */
function objectBox(e: PlateEntry): { center: Vec3; size: Vec3 } {
  const b = bounds(e.parts, identity())
  if (!b) return { center: [0, 0, 0], size: [20, 20, 20] }
  return { center: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2], size: [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] }
}

/** Adds a shape as a volume of the object, at its center, a third of its largest side across. */
export async function addPrimitiveVolume(host: Loader, role: VolumeRole, shape: PrimitiveShape, objectId?: string): Promise<string> {
  const e = need(objectId)
  const { center, size } = objectBox(e)
  const side = Math.max(2, Math.round(Math.max(...size) / 3))
  return addVolumeMesh(host, e, role, centered(primitive(shape, side)), center)
}

async function addVolumeMesh(host: Loader, e: PlateEntry, role: VolumeRole, part: MeshPart, position: Vec3): Promise<string> {
  const name = `${ROLE_LABEL[role]} ${(e.volumes ?? []).filter((v) => v.role === role).length + 1}`
  const handle = await host.loadParts(name, [part])
  const v: PlateVolumeEntry = { id: newId(), name, role, handle, part, local: at(position) }
  update(e.id, (list) => [...list, v])
  return v.id
}

/**
 * Turns another object on the plate into a volume of the selected one, keeping where it sits: the
 * way to bring a custom shape in as a cutter or a support blocker. The other object leaves the plate.
 */
export async function useObjectAsVolume(host: Loader, role: VolumeRole, sourceId: string, targetId?: string): Promise<string> {
  const target = need(targetId)
  const src = get().plate.find((p) => p.id === sourceId)
  if (!src || src.id === target.id) throw new Error('Pick a different object.')
  const world = src.parts.map((p) => bake(p, src.transform))
  // Into the target's coordinates: undo the target's transform.
  const inv = invertRigid(target.transform)
  const local = world.map((p) => bake(p, inv))
  const merged = mergeOne(local, src.name)
  const box = bounds([merged], identity())
  const c: Vec3 = box ? [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2] : [0, 0, 0]
  const id = await addVolumeMesh(host, target, role, bake(merged, at([-c[0], -c[1], -c[2]])), c)
  set({ plate: get().plate.filter((p) => p.id !== src.id), selection: target.id, selectedIds: [target.id] })
  return id
}

function mergeOne(parts: MeshPart[], name: string): MeshPart {
  const positions: number[] = []
  const indices: number[] = []
  for (const p of parts) {
    const off = positions.length / 3
    positions.push(...p.positions)
    for (const i of p.indices) indices.push(i + off)
  }
  return { name, slot: 1, positions: new Float32Array(positions), indices: new Uint32Array(indices) }
}

/** Inverse of a matrix made of rotation, uniform or per-axis scale and translation. */
function invertRigid(m: Mat4): Mat4 {
  const t = decompose(m)
  const s = t.scale
  const inv = compose({ position: [0, 0, 0], rotation: t.rotation, scale: [1, 1, 1] })
  // R^T, then scale by 1/s, then the translation that undoes the position.
  const rt = [inv[0]!, inv[4]!, inv[8]!, 0, inv[1]!, inv[5]!, inv[9]!, 0, inv[2]!, inv[6]!, inv[10]!, 0, 0, 0, 0, 1]
  const sc = compose({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1 / s[0], 1 / s[1], 1 / s[2]] })
  const linear = multiply(sc, rt)
  const p = t.position
  const shift = [linear[0]! * p[0] + linear[4]! * p[1] + linear[8]! * p[2], linear[1]! * p[0] + linear[5]! * p[1] + linear[9]! * p[2], linear[2]! * p[0] + linear[6]! * p[1] + linear[10]! * p[2]]
  return [...linear.slice(0, 12), -shift[0]!, -shift[1]!, -shift[2]!, 1]
}

export function removeVolume(objectId: string, volumeId: string): void {
  update(objectId, (list) => list.filter((v) => v.id !== volumeId))
}

export function setVolumeRole(objectId: string, volumeId: string, role: VolumeRole): void {
  update(objectId, (list) =>
    list.map((v) => {
      if (v.id !== volumeId) return v
      // Settings belong to a modifier; another role drops them.
      const { settings: _s, ...rest } = v
      return { ...rest, role, name: v.name.replace(/^[^\d]+/, `${ROLE_LABEL[role]} `), ...(role === 'modifier' && v.settings ? { settings: v.settings } : {}) }
    }),
  )
}

/** Move, rotate or scale a volume in its object's coordinates. */
export function setVolumeTrs(objectId: string, volumeId: string, patch: Partial<Trs>): void {
  update(objectId, (list) =>
    list.map((v) => {
      if (v.id !== volumeId) return v
      const cur = decompose(v.local)
      return { ...v, local: compose({ ...cur, ...patch }) }
    }),
  )
}

/** Sets a volume's size along one axis in mm, uniform or not. Sizes are measured on its own mesh times its scale. */
export function setVolumeSize(objectId: string, volumeId: string, axis: 0 | 1 | 2, mm: number, uniform: boolean): void {
  const e = get().plate.find((p) => p.id === objectId)
  const v = e?.volumes?.find((x) => x.id === volumeId)
  if (!v || !(mm > 0)) return
  const b = bounds([v.part], identity())
  if (!b) return
  const own = b.max[axis]! - b.min[axis]!
  if (own <= 0) return
  const cur = decompose(v.local)
  const f = mm / (own * Math.abs(cur.scale[axis]!))
  const scale: Vec3 = uniform ? [cur.scale[0] * f, cur.scale[1] * f, cur.scale[2] * f] : (cur.scale.map((s, i) => (i === axis ? s * f : s)) as Vec3)
  setVolumeTrs(objectId, volumeId, { scale })
}

export function volumeSize(v: PlateVolumeEntry): Vec3 {
  const b = bounds([v.part], v.local)
  const t = decompose(v.local)
  const own = bounds([v.part], identity())
  if (!b || !own) return [0, 0, 0]
  // Size along the volume's own axes, not the axis-aligned box of a rotated one.
  return [(own.max[0] - own.min[0]) * Math.abs(t.scale[0]), (own.max[1] - own.min[1]) * Math.abs(t.scale[1]), (own.max[2] - own.min[2]) * Math.abs(t.scale[2])]
}

/** The volumes as the slice request takes them: each placed in bed coordinates. */
export function requestVolumes(e: PlateEntry): PlateVolume[] {
  return (e.volumes ?? []).map((v) => ({ name: v.name, role: v.role, mesh: v.handle.id, transform: multiply(e.transform, v.local), ...(v.role === 'modifier' && v.settings && Object.keys(v.settings).length ? { settings: v.settings } : {}) }))
}

/** Sets or clears (undefined) one setting of a modifier volume. */
export function setModifierSetting(objectId: string, volumeId: string, key: string, value: SettingValue | undefined): void {
  update(objectId, (list) =>
    list.map((v) => {
      if (v.id !== volumeId) return v
      const next = { ...(v.settings ?? {}) }
      if (value === undefined) delete next[key]
      else next[key] = value
      const { settings: _old, ...rest } = v
      return Object.keys(next).length ? { ...rest, settings: next } : rest
    }),
  )
}
