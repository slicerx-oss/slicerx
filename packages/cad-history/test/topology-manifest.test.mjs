// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { topologyFaces } from '../src/topology-manifest.ts'
const part = (key = 10, surface = { kind: 'cylinder', radius: 3 }) => ({ name: 'part', slot: 0, positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2], faces: { ids: [0], table: [surface], keys: [key] } })
test('groups curved face metadata and labels tessellated area separately', () => {
  const { faces, metadataComplete } = topologyFaces([part()], true)
  assert.equal(metadataComplete, true)
  assert.equal(faces.length, 1)
  assert.deepEqual(faces[0].dimensions, { areaMm2: 2, diameterMm: 6 })
  assert.deepEqual(faces[0].measurementSource, { area: 'tessellation', surface: 'kernel_metadata' })
})
test('duplicate keys across parts are ambiguous and absent keys stay absent', () => {
  const { faces } = topologyFaces([part(), part(), part(0)], true)
  assert.deepEqual(faces.map(f => f.ambiguity), ['duplicate_key', 'duplicate_key', 'missing_key'])
  assert.equal(faces[2].faceKey, null)
})
test('a mesh fit never claims kernel measurement and unknown surfaces stay unknown', () => {
  assert.equal(topologyFaces([part()], false).faces[0].measurementSource.surface, 'mesh_metadata')
  assert.equal(topologyFaces([part(1, { kind: 'other' })], true).faces[0].surfaceType, 'unknown')
  assert.equal(topologyFaces([part(1, { kind: 'cylinder', radius: NaN })], true).faces[0].dimensions.diameterMm, undefined)
  const overflow = topologyFaces([part(1, { kind: 'sphere', radius: Number.MAX_VALUE })], true)
  assert.equal(overflow.metadataComplete, false)
  assert.equal(overflow.faces[0].dimensions.diameterMm, undefined)
})
test('invalid and absent face data are explicit, never converted to a planar identity', () => {
  const invalid = part(); invalid.indices[2] = 999
  const result = topologyFaces([invalid], true)
  assert.equal(result.metadataComplete, false)
  assert.equal(result.faces[0].dimensions.areaMm2, null)
  const missing = part(); delete missing.faces
  assert.deepEqual(topologyFaces([missing], true), { faces: [], metadataComplete: false })
})
