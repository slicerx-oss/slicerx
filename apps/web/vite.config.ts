// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { sharedConfig } from './vite.shared'

export default defineConfig(({ command }) => sharedConfig(import.meta.dirname, 5173, resolve(import.meta.dirname, '../../editions/slicerx/edition.config.ts'), process.env['SLICERX_WEB_BASE'] ?? '/studio/', command))
