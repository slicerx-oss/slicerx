// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { topologyFaces, topologyManifest, topologyFace } from '../src/topology-manifest.ts'
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

const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 12, 0, 0, 1]
test('the manifest keeps local measurements separate from world placement', () => {
  const manifest = topologyManifest('body', 'revision', [part()], transform, true)
  assert.equal(manifest.coordinates, 'body_local')
  assert.equal(manifest.faces[0].dimensions.diameterMm, 6)
  assert.deepEqual(manifest.transform, transform)
  assert.equal(manifest.capabilities.meshFallback, false)
  assert.equal(topologyFace(manifest, { bodyId: 'body', revision: 'revision', part: 0, faceKey: 10 }), manifest.faces[0])
})

test('a scoped reference refuses another body, stale revision, missing key or ambiguity', () => {
  const manifest = topologyManifest('body', 'revision', [part()], transform, true)
  const reference = { bodyId: 'body', revision: 'revision', part: 0, faceKey: 10 }
  for (const changed of [{ bodyId: 'other' }, { revision: 'old' }]) {
    assert.throws(() => topologyFace(manifest, { ...reference, ...changed }), { code: 'stale_body' })
  }
  assert.throws(() => topologyFace(manifest, { ...reference, faceKey: 11 }), { code: 'missing_face' })
  const ambiguous = topologyManifest('body', 'revision', [part(), part()], transform, true)
  assert.equal(ambiguous.metadataComplete, false)
  assert.throws(() => topologyFace(ambiguous, reference), { code: 'ambiguous_face' })
})

test('invalid placement cannot produce a misleading measurement envelope', () => {
  assert.throws(() => topologyManifest('body', 'revision', [part()], [], true))
  assert.throws(() => topologyManifest('body', 'revision', [part()], transform.map(() => NaN), true))
  assert.throws(() => topologyManifest('body', '', [part()], transform, true))
})

test('plane displacement read-back uses millimeters even with a scaled equation', () => {
  const before = topologyFaces([part(1, { kind: 'plane', normal: [0, 0, 2], offset: 4 })], true)
  const after = topologyFaces([part(1, { kind: 'plane', normal: [0, 0, 2], offset: 10 })], true)
  assert.equal(before.faces[0].dimensions.planeOffsetMm, 2)
  assert.equal(after.faces[0].dimensions.planeOffsetMm, 5)
  const missing = topologyFaces([part(1, { kind: 'plane', normal: [0, 0, 0], offset: 4 })], true)
  assert.equal(missing.metadataComplete, false)
  assert.equal(missing.faces[0].dimensions.planeOffsetMm, undefined)
})
