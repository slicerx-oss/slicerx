// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Library build for publishing: dist/index.js, dist/mesh.js and dist/sxlock.js. React, zod and @slicerx/viewport
// (published on its own) stay external; the unpublished workspace packages it uses
// (@slicerx/contracts, @slicerx/settings, @slicerx/ui) are bundled. Types come from
// scripts/emit-types.mjs.
//
// The view's mesh worker is dist/mesh-build-worker.js, one file with the mesh math in it and no imports. The code that
// starts it keeps the plain `new Worker(new URL('./mesh-build-worker.js', import.meta.url), ...)` form, which the
// host's bundler (Vite, webpack 5, Parcel, Rollup with a worker plugin) recognizes and emits; Vite would otherwise
// write a root-relative URL it tells other bundlers to ignore.
import { posix } from 'node:path'
import { defineConfig } from 'vite'

const external = ['react', 'react-dom', 'zod', 'three', '@slicerx/viewport']
const WORKER = 'mesh-build-worker.js'

/** Puts the worker URL back in the form host bundlers look for, relative to the chunk that starts it. */
function plainWorkerUrl() {
  return {
    name: 'sx-plain-worker-url',
    enforce: 'post',
    renderChunk(code, chunk) {
      const vite = /new URL\(\s*(?:\/\*\s*@vite-ignore\s*\*\/\s*)?"[^"]*mesh-build-worker\.js"\s*,\s*(?:""\s*\+\s*)?import\.meta\.url\s*\)/g
      if (!vite.test(code)) return null
      let rel = posix.relative(posix.dirname(chunk.fileName), WORKER)
      if (!rel.startsWith('.')) rel = `./${rel}`
      return { code: code.replace(vite, `new URL(${JSON.stringify(rel)}, import.meta.url)`), map: null }
    },
  }
}

export default defineConfig({
  plugins: [plainWorkerUrl()],
  worker: { format: 'es', rollupOptions: { output: { entryFileNames: WORKER } } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    lib: { entry: { index: 'src/index.ts', mesh: 'src/mesh.ts', sxlock: 'src/sxlock.ts' }, formats: ['es'] },
    rollupOptions: {
      external: (id) => external.some((e) => id === e || id.startsWith(e + '/')),
      output: { chunkFileNames: 'chunks/[name]-[hash].js' },
    },
  },
})
