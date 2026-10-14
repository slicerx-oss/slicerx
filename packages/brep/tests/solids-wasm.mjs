// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import init from '../lib/sx_brep.mjs'

const fixtures = JSON.parse(readFileSync(new URL('./solid-cases.json', import.meta.url), 'utf8'))
const kernel = await init({ wasmBinary: readFileSync(new URL('../lib/sx_brep.wasm', import.meta.url)) })
function call(op, request) {
  const text = JSON.stringify(request)
  const o = kernel.stringToNewUTF8(op)
  const r = kernel.stringToNewUTF8(text)
  let reply = 0
  try {
    reply = kernel._sx_brep_call(o, r)
    assert.ok(reply, 'kernel reply allocation')
    const result = JSON.parse(kernel.UTF8ToString(reply))
    assert.equal(result.error, undefined, result.error)
    return result
  } finally {
    if (reply) kernel._sx_brep_free(reply)
    kernel._free(r)
    kernel._free(o)
  }
}

function request(value, key, scale, offset, bodies) {
  if (typeof value === 'string' && value.startsWith('$')) {
    assert.ok(bodies.has(value.slice(1)), `unknown body ${value}`)
    return bodies.get(value.slice(1))
  }
  if (typeof value === 'number') return value * scale
  if (Array.isArray(value)) {
    if (['axis', 'face'].includes(key)) return value
    if (['min', 'max', 'origin', 'a', 'b'].includes(key)) return value.map((n, i) => n * scale + offset[i])
    return value.map(v => request(v, '', scale, offset, bodies))
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, request(v, k, scale, offset, bodies)]))
  return value
}

function near(actual, expected, tolerance, label) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: ${actual} expected ${expected} within ${tolerance}`)
}

function meshCheck(mesh, offset, expected) {
  const { positions: p, indices: ix, faceIds } = mesh
  assert.ok(p.length > 0 && p.length % 3 === 0 && p.every(Number.isFinite))
  assert.ok(ix.length > 0 && ix.length % 3 === 0)
  assert.equal(faceIds.length * 3, ix.length)
  const edges = new Map()
  let volume = 0
  for (let i = 0; i < ix.length; i += 3) {
    const ids = ix.slice(i, i + 3)
    assert.equal(new Set(ids).size, 3)
    for (let j = 0; j < 3; j++) {
      const a = ids[j], b = ids[(j + 1) % 3]
      assert.ok(Number.isInteger(a) && a >= 0 && a * 3 + 2 < p.length)
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`
      const edge = edges.get(key) ?? [0, 0]
      edge[0]++
      edge[1] += a < b ? 1 : -1
      edges.set(key, edge)
    }
    const [a, b, c] = ids.map(id => offset.map((n, j) => p[id * 3 + j] - n))
    volume += (a[0] * (b[1]*c[2]-b[2]*c[1]) - a[1] * (b[0]*c[2]-b[2]*c[0]) + a[2] * (b[0]*c[1]-b[1]*c[0])) / 6
  }
  for (const edge of edges.values()) assert.deepEqual(edge, [2, 0], 'closed consistently oriented mesh')
  near(volume, expected, expected * 0.005, 'tessellated volume')
}

for (const fixture of fixtures) for (const scale of [0.1, 1, 10]) for (const offset of [[0, 0, 0], [1000, -700, 350]]) {
  test(`${fixture.name}, scale ${scale}, offset ${offset}`, () => {
    const baseline = call('count', {}).bodies
    const held = []
    const bodies = new Map()
    try {
      for (const [name, op, input] of fixture.steps) {
        const body = call(op, request(input, '', scale, offset, bodies)).body
        assert.equal(typeof body, 'number')
        held.push(body)
        bodies.set(name, body)
      }
      const body = bodies.get('result')
      const expected = (fixture.volume[0] + Math.PI * fixture.volume[1]) * scale ** 3
      const tolerance = expected * (fixture.tolerance ?? 1e-6)
      const verify = id => {
        const info = call('info', { body: id })
        assert.equal(info.manifold, true)
        near(info.volumeMm3, expected, tolerance, 'analytic volume')
        for (let i = 0; i < 3; i++) {
          near(info.bounds.min[i], offset[i], 1e-6 * Math.max(1, scale), 'minimum')
          near(info.bounds.max[i], offset[i] + fixture.bounds[i] * scale, 1e-6 * Math.max(1, scale), 'maximum')
        }
        meshCheck(call('tessellate', { body: id, chordMm: 0.01 * scale, angleDeg: 15 }), offset, expected)
      }
      verify(body)
      const saved = call('save', { body }).smb
      const loaded = call('load', { body: { smb: saved } }).body
      held.push(loaded)
      verify(loaded)
    } finally {
      for (const body of held.reverse()) call('free', { body })
      assert.equal(call('count', {}).bodies, baseline)
    }
  })
}
