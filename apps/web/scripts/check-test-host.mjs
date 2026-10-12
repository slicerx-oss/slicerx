// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Fails when a product build carries the end-to-end test slicer (src/host/native-test.ts), which only a build with
// SLICERX_E2E=1 and SLICERX_E2E_NATIVE_URL may include. Reads every file of each build folder given.
//   node scripts/check-test-host.mjs dist [dist-cad-only ...]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Strings the test slicer's code keeps in any build that includes it. Checked against its source first, so renaming
// one cannot make this check pass by accident.
const MARKERS = ['The test slicer returned an unexpected slice result', 'native-slice-']
const source = readFileSync(new URL('../src/host/native-test.ts', import.meta.url), 'utf8')
for (const m of MARKERS) if (!source.includes(m)) throw new Error(`check-test-host: "${m}" is no longer in src/host/native-test.ts; update MARKERS`)

const dirs = process.argv.slice(2)
if (!dirs.length) throw new Error('usage: check-test-host.mjs <build dir> ...')
let bad = 0
for (const dir of dirs) {
  let files = 0
  let hits = 0
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else {
        files++
        const text = readFileSync(p, 'latin1')
        for (const m of MARKERS)
          if (text.includes(m)) {
            console.error(`check-test-host: ${p} carries the end-to-end test slicer ("${m}")`)
            hits++
          }
      }
    }
  }
  walk(dir)
  if (files === 0) throw new Error(`check-test-host: ${dir} is empty`)
  if (hits) bad++
  else console.log(`check-test-host: ${dir}, ${files} files, no test slicer`)
}
process.exit(bad ? 1 : 0)
