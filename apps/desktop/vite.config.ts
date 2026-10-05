// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { resolve } from 'node:path'
import { sharedConfig } from '@slicerx/web/vite'
import { defineConfig } from 'vite'

// Tauri serves dist/ from its own origin; the dev server must keep one fixed port.
export default defineConfig(async ({ command }) => {
  const shared = await sharedConfig(import.meta.dirname, 5174, resolve(import.meta.dirname, '../../editions/slicerx/edition.config.ts'), './', command)
  return { ...shared, server: { ...shared.server, strictPort: true }, clearScreen: false }
})
