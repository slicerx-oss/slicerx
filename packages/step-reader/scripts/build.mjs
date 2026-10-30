// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds dist/ for the npm package: index.js, node.js and node-worker.js (one shared chunk beside them, so StepError is
// one class whichever entry it comes from), the OpenCASCADE glue and wasm copied unchanged next to them, and the type
// declarations. Everything sits in dist/ itself: the code finds the wasm and the worker with new URL('./...',
// import.meta.url), relative to the file it runs from.
//   node scripts/build.mjs [<out dir>]
import { execFileSync } from 'node:child_process'
import { copyFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(process.argv[2] ?? join(pkg, 'dist'))
rmSync(out, { recursive: true, force: true })
await build({
  entryPoints: ['index', 'node', 'node-worker'].map((n) => join(pkg, 'src', `${n}.ts`)),
  outdir: out,
  bundle: true,
  splitting: true,
  chunkNames: '[name]-[hash]',
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['node:*'],
  plugins: [
    {
      // The glue stays its own file, loaded on first use, beside the wasm it fetches.
      name: 'occt-glue',
      setup(b) {
        b.onResolve({ filter: /occt-import-js\.mjs$/ }, () => ({ path: './occt-import-js.mjs', external: true }))
      },
    },
  ],
  legalComments: 'inline',
  logLevel: 'warning',
})
for (const f of ['occt-import-js.mjs', 'occt-import-js.wasm']) copyFileSync(join(pkg, 'src', f), join(out, f))
execFileSync(process.execPath, [join(pkg, '..', '..', 'scripts', 'emit-types.mjs'), pkg, 'index=src/index.ts', 'node=src/node.ts', '--out', out], { stdio: 'inherit' })
