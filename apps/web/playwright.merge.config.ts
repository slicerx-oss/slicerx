// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { defineConfig } from '@playwright/test'

// Report merging needs one tests location when the blobs come from runners with different checkout paths.
export default defineConfig({ testDir: 'e2e' })
