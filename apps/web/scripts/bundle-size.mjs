// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Checks the browser build against its budgets: the JS that
// loads before the viewport and WASM (the entry chunk and its static imports)
// at most 235 KB gzip, and each WASM module at most 1.0 MB gzip. The STEP reader (OpenCASCADE, loaded
// only when a STEP file opens) has a budget of its own and must not be reachable from the shell, and so does the
// full geometry engine (the modeling tools and the heavier modules, loaded the first time a call needs them). It
// also fails when printer, filament or G-code profile data lands in a startup chunk, and when a startup chunk
// names an icon that is not in the startup icon table.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const dist = join(import.meta.dirname, '..', 'dist')
const manifest = JSON.parse(readFileSync(join(dist, '.vite', 'manifest.json'), 'utf8'))
const SHELL_KB = 235
const WASM_KB = 1040
const STEP_WASM_KB = 3584
const FULL_GEOM_WASM_KB = 1536
const isStepReader = (file) => /occt-import-js/.test(file)
const isFullGeom = (file) => /sx_geom_wasm/.test(file)

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
// Only the icons in packages/ui/icons/startup.mjs load with the shell; the rest draw as an empty box until their
// table arrives. A startup chunk that names any other icon (a quoted name that is not an object key) would show
// it popping in, so the build fails and names it: add it to startup.mjs and run gen-icons.mjs. Names built at run
// time (a template string) are not seen here.
const icons = join(import.meta.dirname, '..', '..', '..', 'packages', 'ui', 'icons')
const drawn = new Set()
for (const [file, key] of [['base.mjs', 'BASE_ICONS'], ['extra.mjs', 'EXTRA_ICONS'], ['hardware.mjs', 'HARDWARE_ICONS']]) {
  for (const name of Object.keys((await import(pathToFileURL(join(icons, file)).href))[key])) drawn.add(name)
}
const startup = new Set((await import(pathToFileURL(join(icons, 'startup.mjs')).href)).STARTUP_ICONS)
const late = new Map()
for (const key of seen) {
  const text = readFileSync(join(dist, manifest[key].file), 'utf8')
  for (const [, , name] of text.matchAll(/(["'`])([a-z0-9-]+)\1(?!\s*:)/g)) {
    if (drawn.has(name) && !startup.has(name)) late.set(name, manifest[key].file)
  }
}
for (const [name, file] of late) {
  console.error(`bundle-size: the startup chunk ${file} names the icon "${name}", which is not in packages/ui/icons/startup.mjs`)
  failed = true
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
  const budget = isStepReader(f) ? STEP_WASM_KB : isFullGeom(f) ? FULL_GEOM_WASM_KB : WASM_KB
  console.log(`wasm ${f}: ${(size / 1024).toFixed(1)} KB gzip (budget ${budget} KB)`)
  if (size > budget * 1024) failed = true
}
if (failed) {
  console.error('bundle-size: failed, see above')
  process.exit(1)
}
