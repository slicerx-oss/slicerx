// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model geometry and 3MF metadata through pkg/sx_wasm.wasm: loads the two-color
// 3MF benchmark model, reads its parts back with decodeParts and checks them
// against the load report, then reads the project metadata.
//
//   node packages/core/web/scripts/check-wasm-models.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeParts, encodeParts } from '../src/parts.ts'

const here = dirname(fileURLToPath(import.meta.url))
const model = readFileSync(join(here, '..', '..', 'bench', 'models', 'x-mark-2color.3mf'))
const module = await WebAssembly.compile(readFileSync(join(here, '..', 'pkg', 'sx_wasm.wasm')))
const { exports: x } = await WebAssembly.instantiate(module, {})
const put = (b) => {
  const p = x.sx_input(b.length)
  new Uint8Array(x.memory.buffer, p, b.length).set(b)
}
const out = (w) => new Uint8Array(x.memory.buffer, x.sx_out_ptr(w), x.sx_out_len(w)).slice()
const withName = (name, data) => {
  const n = new TextEncoder().encode(name)
  const buf = new Uint8Array(n.length + 1 + data.length)
  buf.set(n)
  buf.set(data, n.length + 1)
  return buf
}

put(withName('x-mark-2color.3mf', model))
const id = x.sx_load_mesh()
assert.notEqual(id, 0)
const info = JSON.parse(new TextDecoder().decode(out(2)))
assert.equal(x.sx_mesh_parts(id), 0)
const parts = decodeParts(out(3))
assert.equal(parts.length, info.parts.length)
assert.deepEqual(new Set(parts.map((p) => p.slot)), new Set(info.parts.map((p) => p.slot)))
assert.ok(parts.length >= 2, 'two colors are two parts')
for (const [i, p] of parts.entries()) {
  assert.equal(p.indices.length / 3, info.parts[i].triangles)
  assert.equal(p.name, info.parts[i].name)
}
// Positions span the reported bounding box.
const lo = [Infinity, Infinity, Infinity]
const hi = [-Infinity, -Infinity, -Infinity]
for (const p of parts) for (let k = 0; k < p.positions.length; k++) {
  lo[k % 3] = Math.min(lo[k % 3], p.positions[k])
  hi[k % 3] = Math.max(hi[k % 3], p.positions[k])
}
for (let a = 0; a < 3; a++) assert.ok(Math.abs(hi[a] - lo[a] - info.bboxMm[a]) < 1e-3)
// The raw format round-trips.
assert.deepEqual(encodeParts(parts), out(3))
assert.notEqual(x.sx_mesh_parts(9999), 0)

put(withName('x-mark-2color.3mf', model))
assert.equal(x.sx_project_metadata(), 0)
const meta = JSON.parse(new TextDecoder().decode(out(2)))
assert.equal(typeof meta.modelSettings, 'string')
assert.equal(meta.projectSettings, undefined)
put(withName('bad.3mf', new Uint8Array([1, 2, 3])))
assert.notEqual(x.sx_project_metadata(), 0)
console.log(`ok   ${parts.length} parts, ${parts.reduce((n, p) => n + p.indices.length / 3, 0)} triangles, metadata keys ${Object.keys(meta).join(',')}`)
