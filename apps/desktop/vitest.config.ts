// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineConfig } from 'vitest/config'

// The shell's own glue, with Tauri mocked. Its own config, so the app build's vite.config.ts is not loaded.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
