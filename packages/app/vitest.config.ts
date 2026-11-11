// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineConfig } from 'vitest/config'

// Several tests load a heavy module on first use (the viewport and three.js, the profile data, the send preflight). On a loaded
// machine that cold import alone passes vitest's 5 s default, so the limit is set well past it: a slow machine must not fail a test that behaves.
// SX_WALL_COUNT_ONLY=1: design.check reads the wall by its facet cap alone in replays, as in packages/mcp.
export default defineConfig({ test: { environment: 'jsdom', include: ['test/**/*.test.ts'], setupFiles: ['test/setup.ts'], testTimeout: 60_000, hookTimeout: 60_000, env: { SX_WALL_COUNT_ONLY: '1' } } })
