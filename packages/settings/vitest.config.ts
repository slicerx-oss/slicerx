// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineConfig } from 'vitest/config'

// Some tests load a vendor's whole filament file on first use (BBL.json alone is 4 MB) and resolve every preset in it. On a
// loaded machine, such as a CI runner testing several packages at once, that passes vitest's 5 s default, so the limit is set
// well past it: a slow machine must not fail a test that behaves.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } })
