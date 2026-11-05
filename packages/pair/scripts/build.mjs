// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds the npm package into dist/: one ES module per entry (index, host, client, relay) with the workspace packages it
// uses inlined (only types and a few helpers from @slicerx/contracts), zod and the @noble crypto libraries left as
// dependencies, and self-contained type declarations (scripts/emit-types.mjs).
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(pkg, '..', '..')
const entries = { index: 'src/index.ts', host: 'src/host.ts', client: 'src/client.ts', relay: 'src/relay.ts' }

rmSync(join(pkg, 'dist'), { recursive: true, force: true })
await build({
  absWorkingDir: pkg,
  entryPoints: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, join(pkg, v)])),
  outdir: join(pkg, 'dist'),
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['zod', '@noble/*'],
  legalComments: 'inline',
  logLevel: 'warning',
})
execFileSync(process.execPath, [join(repo, 'scripts', 'emit-types.mjs'), pkg, ...Object.entries(entries).map(([k, v]) => `${k}=${v}`)], { stdio: 'inherit' })
console.log('built dist/')
