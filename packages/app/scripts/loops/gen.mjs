// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Authoring only: writes each batch's loop modules into packages/app/src/demos. Usage: node gen.mjs [batch ...]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { moduleText } from './stage.mjs'

const OUT = new URL('../../src/demos/', import.meta.url).pathname
for (const b of process.argv.length > 2 ? process.argv.slice(2) : ['batch1']) {
  const mod = await import(`./${b}.mjs`)
  for (const [name, make] of Object.entries(mod.LOOPS)) {
    const l = make()
    writeFileSync(join(OUT, `${name}.ts`), moduleText(l))
    console.log(name.padEnd(20), Buffer.byteLength(l.css) + Buffer.byteLength(l.body))
  }
}

// every loop's id is its class and keyframe prefix, and all tips share one document: ids must be unique
const seen = {}
for (const f of readdirSync(OUT).filter((f) => f.endsWith('.ts'))) {
  const id = readFileSync(join(OUT, f), 'utf8').match(/^  id: '([^']+)'/m)?.[1]
  if (id && seen[id]) throw new Error(`loop id ${id} is used by ${seen[id]} and ${f}`)
  if (id) seen[id] = f
}
