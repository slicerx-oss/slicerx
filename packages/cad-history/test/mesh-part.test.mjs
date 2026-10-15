// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { historyPart } from '../src/mesh-part.ts'
import { topologyFaces } from '../src/topology-manifest.ts'

const mesh = () => ({ name: 'Hole', slot: 1, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], faces: { ids: [0], keys: [123], table: [{ kind: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], radius: 3 }] } })

test('display conversion retains face identity and analytic dimensions', () => {
  const original = mesh(), part = historyPart(original)
  assert.deepEqual(Array.from(part.faces.ids), [0])
  assert.deepEqual(part.faces.keys, [123])
  assert.deepEqual(part.faces.table, original.faces.table)
  const face = topologyFaces([part], true).faces[0]
  assert.equal(face.faceKey, 123)
  assert.equal(face.surfaceType, 'cylinder')
  assert.equal(face.dimensions.diameterMm, 6)
})

test('invalid face mapping is unavailable instead of wrapping into another face', () => {
  for (const ids of [[-1], [1], [0.5], []]) {
    const original = mesh(); original.faces.ids = ids
    assert.equal(historyPart(original).faces, undefined)
  }
})

test('invalid surfaces become unknown and invalid keys remain unselectable', () => {
  const original = mesh()
  original.faces.table[0].axis = [0, 0, 0]
  original.faces.keys[0] = -1
  const part = historyPart(original)
  assert.deepEqual(part.faces.table, [{ kind: 'other' }])
  assert.deepEqual(part.faces.keys, [0])
  assert.equal(topologyFaces([part], true).faces[0].ambiguity, 'missing_key')
})

test('conversion owns its metadata buffers and preserves valid planes', () => {
  const original = mesh()
  original.faces.table = [{ kind: 'plane', normal: [0, 0, 1], offset: 2 }]
  const part = historyPart(original)
  original.faces.ids[0] = 99
  original.faces.keys[0] = 99
  original.faces.table[0].normal[2] = 0
  assert.deepEqual(Array.from(part.faces.ids), [0])
  assert.deepEqual(part.faces.keys, [123])
  assert.deepEqual(part.faces.table, [{ kind: 'plane', normal: [0, 0, 1], offset: 2 }])
})
