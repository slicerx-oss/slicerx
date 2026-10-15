// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { HistoryMesh } from './model'

export interface TopologyFace {
  part: number
  face: number
  faceKey: number | null
  surfaceType: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'unknown'
  ambiguity: 'none' | 'missing_key' | 'duplicate_key'
  dimensions: { areaMm2: number | null; diameterMm?: number; halfAngleRad?: number; planeOffsetMm?: number }
  measurementSource: { area: 'tessellation'; surface: 'kernel_metadata' | 'mesh_metadata' | 'unavailable' }
}

/** Compact local-coordinate metadata. The caller supplies placement and live revision separately. */
export function topologyFaces(parts: readonly HistoryMesh[], exact: boolean): { faces: TopologyFace[]; metadataComplete: boolean } {
  const counts = new Map<number, number>()
  for (const part of parts) for (const key of part.faces?.keys ?? []) {
    if (Number.isSafeInteger(key) && key > 0) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let metadataComplete = true
  const faces: TopologyFace[] = []
  parts.forEach((part, partIndex) => {
    const metadata = part.faces
    if (!metadata || metadata.ids.length !== part.indices.length / 3) { metadataComplete = false; return }
    const areas = metadata.table.map(() => 0)
    const valid = metadata.table.map(() => true)
    for (let triangle = 0; triangle < metadata.ids.length; triangle++) {
      const face = metadata.ids[triangle]!
      if (!Number.isInteger(face) || face < 0 || face >= areas.length) { metadataComplete = false; continue }
      const vertices = [0, 1, 2].map(corner => part.indices[triangle * 3 + corner]!)
      if (vertices.some(v => !Number.isInteger(v) || v < 0 || v * 3 + 2 >= part.positions.length)) { valid[face] = false; continue }
      const points = vertices.map(v => [part.positions[v * 3]!, part.positions[v * 3 + 1]!, part.positions[v * 3 + 2]!])
      if (points.some(p => p.some(v => !Number.isFinite(v)))) { valid[face] = false; continue }
      const u = points[1]!.map((x, axis) => x - points[0]![axis]!)
      const v = points[2]!.map((x, axis) => x - points[0]![axis]!)
      areas[face]! += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2
    }
    metadata.table.forEach((value, face) => {
      const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
      const kind = raw['kind']
      const type = kind === 'plane' || kind === 'cylinder' || kind === 'cone' || kind === 'sphere' ? kind : 'unknown'
      const key = metadata.keys?.[face]
      const faceKey = Number.isSafeInteger(key) && key! > 0 ? key! : null
      const radius = raw['radius']
      const angle = raw['halfAngle']
      const dimensions: TopologyFace['dimensions'] = { areaMm2: valid[face] && Number.isFinite(areas[face]) ? areas[face]! : null }
      const normal = raw['normal'], offset = raw['offset']
      if (type === 'plane' && Array.isArray(normal) && normal.length === 3 && normal.every(n => typeof n === 'number' && Number.isFinite(n)) && typeof offset === 'number') {
        const length = Math.hypot(...normal)
        if (length > 0 && Number.isFinite(length) && Number.isFinite(offset / length)) dimensions.planeOffsetMm = offset / length
      }
      if ((type === 'cylinder' || type === 'sphere') && typeof radius === 'number' && Number.isFinite(2 * radius) && radius > 0) dimensions.diameterMm = 2 * radius
      if (type === 'cone' && typeof angle === 'number' && Number.isFinite(angle) && angle > 0 && angle < Math.PI / 2) dimensions.halfAngleRad = angle
      if (dimensions.areaMm2 === null) metadataComplete = false
      if ((type === 'cylinder' || type === 'sphere') && dimensions.diameterMm === undefined) metadataComplete = false
      if (type === 'cone' && dimensions.halfAngleRad === undefined) metadataComplete = false
      if (type === 'plane' && dimensions.planeOffsetMm === undefined) metadataComplete = false
      if (type === 'unknown' || faceKey === null || counts.get(faceKey)! > 1) metadataComplete = false
      faces.push({ part: partIndex, face, faceKey, surfaceType: type,
        ambiguity: faceKey === null ? 'missing_key' : counts.get(faceKey)! > 1 ? 'duplicate_key' : 'none',
        dimensions, measurementSource: { area: 'tessellation', surface: type === 'unknown' ? 'unavailable' : exact ? 'kernel_metadata' : 'mesh_metadata' } })
    })
  })
  return { faces, metadataComplete }
}

export interface TopologyReference {
  bodyId: string
  revision: string
  part: number
  faceKey: number
}

export interface TopologyManifest {
  version: 1
  bodyId: string
  revision: string
  representation: 'exact' | 'mesh'
  coordinates: 'body_local'
  transform: number[]
  metadataComplete: boolean
  capabilities: { inspectFaces: true; revisionGuard: true; meshFallback: boolean }
  faces: TopologyFace[]
}

export function topologyManifest(bodyId: string, revision: string, parts: readonly HistoryMesh[], transform: readonly number[], exact: boolean): TopologyManifest {
  if (!bodyId || !revision) throw new Error('A topology manifest requires a live body identity and revision')
  if (transform.length !== 16 || transform.some(n => !Number.isFinite(n))) throw new Error('The body placement is invalid')
  return { version: 1, bodyId, revision, representation: exact ? 'exact' : 'mesh', coordinates: 'body_local', transform: [...transform],
    ...topologyFaces(parts, exact), capabilities: { inspectFaces: true, revisionGuard: true, meshFallback: !exact } }
}

export class TopologyReferenceError extends Error {
  readonly code: 'stale_body' | 'missing_face' | 'ambiguous_face'
  constructor(code: TopologyReferenceError['code'], message: string) { super(message); this.code = code }
}

/** Resolve only inside the inspected body revision; never choose a descendant by size or distance. */
export function topologyFace(manifest: TopologyManifest, reference: TopologyReference): TopologyFace {
  if (reference.bodyId !== manifest.bodyId || reference.revision !== manifest.revision) {
    throw new TopologyReferenceError('stale_body', 'The body changed or was replaced. Inspect it again before editing.')
  }
  const found = manifest.faces.filter(face => face.part === reference.part && face.faceKey === reference.faceKey)
  if (!found.length) throw new TopologyReferenceError('missing_face', 'That face is absent from this body revision.')
  if (found.length !== 1 || found[0]!.ambiguity !== 'none') throw new TopologyReferenceError('ambiguous_face', 'That face key has multiple matches. Inspect and repair the selection explicitly.')
  return found[0]!
}
