// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/renderer',
  base: './',
  publicDir: '../../public',
  build: { outDir: '../../dist', emptyOutDir: true, target: 'es2022' },
})
