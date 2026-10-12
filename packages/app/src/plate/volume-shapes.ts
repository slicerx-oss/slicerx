// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Volumes a tool places by shape and size (region_modifiers' hole rings and regions), as opposed to the ones a person
// adds from Prepare. Loaded on first use, so it stays out of the startup chunk.
import type { MeshHandle, MeshPart, SettingValue } from '@slicerx/contracts'
import type { PlateVolumeEntry, VolumeRole } from '../state/store'
import { bake, boxMesh, cylinderMesh, sphereMesh } from './mesh-ops'
import { bounds, compose, identity, type Vec3 } from './transform'

export type VolumeShape = { kind: 'box'; sizeMm: [number, number, number] } | { kind: 'cylinder'; diameterMm: number; heightMm: number } | { kind: 'sphere'; diameterMm: number }

const at = (position: Vec3) => compose({ position, rotation: [0, 0, 0], scale: [1, 1, 1] })

/** A volume's shape sized in mm, centered on its own origin (a cylinder stands along Z). */
export function shapedPart(shape: VolumeShape): MeshPart {
  const part = shape.kind === 'box' ? boxMesh(shape.sizeMm[0], shape.sizeMm[1], shape.sizeMm[2]) : shape.kind === 'sphere' ? sphereMesh(shape.diameterMm) : cylinderMesh(shape.diameterMm, shape.heightMm)
  const b = bounds([part], identity())
  if (!b) return part
  return bake(part, at([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2, -(b.min[2] + b.max[2]) / 2]))
}

/** A volume entry for an object: the part centered at `position` in the object's own coordinates. */
export function volumeAt(id: string, name: string, role: VolumeRole, handle: MeshHandle, part: MeshPart, position: Vec3, settings?: Record<string, SettingValue>): PlateVolumeEntry {
  return { id, name, role, handle, part, local: at(position), ...(role === 'modifier' && settings && Object.keys(settings).length ? { settings } : {}) }
}
