// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Times nest.arrange in the browser build of sx-geom (wasm/pkg/sx_geom_wasm.wasm) on the benchmark's
// requests, written by `cargo run --release -p sx-geom --example nest_bench -- problems DIR`:
//   node nest-wasm-time.mjs DIR
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGeom } from '../wasm/geom.mjs'

const dir = process.argv[2]
const wasm = new URL('../wasm/pkg/sx_geom_wasm.wasm', import.meta.url)
const geom = await createGeom(await WebAssembly.compile(readFileSync(wasm)))
for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
  const req = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  const t0 = performance.now()
  const r = geom.call('nest.arrange', req)
  console.log(JSON.stringify({ plate: f.replace(/\.json$/, ''), placed: r.stats.placed, passes: r.stats.passes, ms: Math.round(performance.now() - t0) }))
}
