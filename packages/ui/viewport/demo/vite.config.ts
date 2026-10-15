// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  server: { fs: { allow: [fileURLToPath(new URL('../../../..', import.meta.url))] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { index: fileURLToPath(new URL('index.html', import.meta.url)), look: fileURLToPath(new URL('look.html', import.meta.url)) } },
  },
})
