// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Each test file runs in its own module scope, so the first test in every file pays the server's cold start: loading
// every tool module on the first connect and the first read of the stock catalog. That is about 0.5 s on a quiet
// machine, but 3 to 6 s in the merge queue's crates part beside the other suites, so vitest's 5 s default failed a
// first try now and then (errors.test.ts, the sxlock and stock catalog tests before it). Later tests in a file take
// well under a second. As in packages/app, settings and embed, a test gets a minute; a real hang still fails.
import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } })
