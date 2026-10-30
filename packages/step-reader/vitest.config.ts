// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineConfig } from 'vitest/config'

// Loading OpenCASCADE takes a second or two, and the packing and bundler tests build the package; on a loaded machine
// that passes vitest's 5 s default, so a test gets a minute as in the other packages. A real hang still fails.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 } })
