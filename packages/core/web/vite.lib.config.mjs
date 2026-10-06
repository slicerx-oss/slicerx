// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Library build for publishing: dist/index.js, the worker chunk and the
// WASM module next to it. @slicerx/contracts is bundled, since it is not
// published. Types come from scripts/emit-types.mjs.
import { defineConfig } from 'vite'

export default defineConfig({
  define: { __SX_WASM_URL__: JSON.stringify('./sx_wasm.wasm') },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'index' },
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
})
