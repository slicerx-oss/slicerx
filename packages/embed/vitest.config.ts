// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineConfig } from 'vitest/config'

// A test's first render loads the piece and its model tools on first use. On a loaded machine that passed vitest's 5 s
// default, so the limit is set well past it, as in packages/app: a slow machine must not fail a test that behaves.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } })
