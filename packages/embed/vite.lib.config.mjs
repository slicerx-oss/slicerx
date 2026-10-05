// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Library build for publishing: dist/index.js, dist/mesh.js and dist/sxlock.js. React, zod and @slicerx/viewport
// (published on its own) stay external; the unpublished workspace packages it uses
// (@slicerx/contracts, @slicerx/settings, @slicerx/ui) are bundled. Types come from
// scripts/emit-types.mjs.
import { defineConfig } from 'vite'

const external = ['react', 'react-dom', 'zod', 'three', '@slicerx/viewport']

export default defineConfig({
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
