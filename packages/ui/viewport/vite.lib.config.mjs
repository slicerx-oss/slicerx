// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Library build for publishing: dist/index.js, dist/palette.js and dist/summary.js, with shared
// code in chunks. three stays external (a dependency); @slicerx/contracts is bundled, since it
// is not published. Types come from scripts/emit-types.mjs.
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    sourcemap: false,
    lib: {
      entry: { index: 'src/index.ts', palette: 'src/palette.ts', summary: 'src/summary.ts' },
      formats: ['es'],
    },
    rollupOptions: {
      external: (id) => id === 'three' || id.startsWith('three/'),
      output: { chunkFileNames: 'chunks/[name]-[hash].js' },
    },
  },
})
