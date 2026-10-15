// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { FaceSurface, MeshPart } from '@slicerx/contracts'
import type { HistoryMesh } from './model'

const vector = (value: unknown): value is [number, number, number] => Array.isArray(value) && value.length === 3 && value.every(n => typeof n === 'number' && Number.isFinite(n))
const direction = (value: unknown): value is [number, number, number] => vector(value) && Number.isFinite(Math.hypot(...value)) && Math.hypot(...value) > 0

function surface(value: unknown): FaceSurface {
  if (!value || typeof value !== 'object') return { kind: 'other' }
  const s = value as Record<string, unknown>
  const radius = s['radius']
  switch (s['kind']) {
    case 'plane':
      if (direction(s['normal']) && typeof s['offset'] === 'number' && Number.isFinite(s['offset'])) return { kind: 'plane', normal: [...s['normal']], offset: s['offset'] }
      break
    case 'cylinder':
      if (vector(s['origin']) && direction(s['axis']) && typeof radius === 'number' && Number.isFinite(radius) && radius > 0) return { kind: 'cylinder', origin: [...s['origin']], axis: [...s['axis']], radius }
      break
    case 'cone':
      if (vector(s['apex']) && direction(s['axis']) && typeof s['halfAngle'] === 'number' && Number.isFinite(s['halfAngle']) && s['halfAngle'] > 0 && s['halfAngle'] < Math.PI / 2) return { kind: 'cone', apex: [...s['apex']], axis: [...s['axis']], halfAngle: s['halfAngle'] }
      break
    case 'sphere':
      if (vector(s['center']) && typeof radius === 'number' && Number.isFinite(radius) && radius > 0) return { kind: 'sphere', center: [...s['center']], radius }
      break
  }
  return { kind: 'other' }
}

/** Keep face provenance when converting unchanged replay triangles for display. */
export function historyPart(m: HistoryMesh): MeshPart {
  const part: MeshPart = { name: m.name, slot: m.slot,
    positions: m.positions instanceof Float32Array ? m.positions : new Float32Array(m.positions),
    indices: m.indices instanceof Uint32Array ? m.indices : new Uint32Array(m.indices) }
  const faces = m.faces
  if (!faces || faces.ids.length !== m.indices.length / 3) return part
  const ids = Array.from(faces.ids)
  if (ids.some(id => !Number.isInteger(id) || id < 0 || id >= faces.table.length)) return part
  part.faces = { ids: new Uint32Array(ids), table: faces.table.map(surface) }
  if (faces.keys?.length === faces.table.length) part.faces.keys = faces.keys.map(key => Number.isSafeInteger(key) && key > 0 ? key : 0)
  return part
}
