// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Checks the browser build against its budgets: the JS that
// loads before the viewport and WASM (the entry chunk and its static imports)
// at most 250 KB gzip, and each WASM module at most 1.0 MB gzip. The STEP reader (OpenCASCADE, loaded
// only when a STEP file opens) has a budget of its own and must not be reachable from the shell. It
// also fails when printer, filament or G-code profile data lands in a startup chunk.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const dist = join(import.meta.dirname, '..', 'dist')
const manifest = JSON.parse(readFileSync(join(dist, '.vite', 'manifest.json'), 'utf8'))
const SHELL_KB = 250
const WASM_KB = 1024
const STEP_WASM_KB = 3584
const isStepReader = (file) => /occt-import-js/.test(file)

const gz = (file) => gzipSync(readFileSync(join(dist, file)), { level: 9 }).length

const seen = new Set()
function walk(key) {
  if (seen.has(key)) return
  seen.add(key)
  const chunk = manifest[key]
  for (const k of chunk.imports ?? []) walk(k)
}
const entry = Object.keys(manifest).find((k) => manifest[k].isEntry)
if (!entry) throw new Error('No entry chunk in the Vite manifest')
walk(entry)

let shell = 0
const rows = []
for (const key of seen) {
  const file = manifest[key].file
  const size = gz(file)
  shell += size
  rows.push([file, size])
}
rows.sort((a, b) => b[1] - a[1])
for (const [file, size] of rows) console.log(`${(size / 1024).toFixed(1).padStart(8)} KB  ${file}`)
console.log(`shell JS: ${(shell / 1024).toFixed(1)} KB gzip (budget ${SHELL_KB} KB)`)

let failed = shell > SHELL_KB * 1024
// Printer, filament and G-code profile data load on demand. It must never sit in a chunk the shell loads at startup.
const PROFILE_MARKERS = ['Bambu PLA Basic', 'Polymaker PolyTerra', 'PRINT_START EXTRUDER', 'M620 S[next_extruder]']
for (const key of seen) {
  const text = readFileSync(join(dist, manifest[key].file), 'utf8')
  for (const m of PROFILE_MARKERS) {
    if (text.includes(m)) {
      console.error(`bundle-size: profile data ("${m}") is in the startup chunk ${manifest[key].file}`)
      failed = true
    }
  }
}
const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)).map((x) => join(f, x)) : [f]))
for (const key of seen) {
  if (isStepReader(manifest[key].file)) {
    console.error(`bundle-size: the STEP reader is in the startup chunk ${manifest[key].file}`)
    failed = true
  }
}
for (const f of files(dist).filter((f) => f.endsWith('.wasm'))) {
  const size = gz(f)
  const budget = isStepReader(f) ? STEP_WASM_KB : WASM_KB
  console.log(`wasm ${f}: ${(size / 1024).toFixed(1)} KB gzip (budget ${budget} KB)`)
  if (size > budget * 1024) failed = true
}
if (failed) {
  console.error('bundle-size: over budget')
  process.exit(1)
}
