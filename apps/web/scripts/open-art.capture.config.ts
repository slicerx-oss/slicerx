// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs scripts/open-art.capture.ts, which writes the first-run card art. Same app, native engine and browser flags as the
// suite (playwright.config.ts); only the files it looks at and where the servers start from differ.
import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'
import base from '../playwright.config.ts'

const web = resolve(import.meta.dirname, '..')

export default defineConfig({
  ...base,
  testDir: import.meta.dirname,
  testMatch: 'open-art.capture.ts',
  timeout: 600_000,
  workers: 1,
  projects: base.projects!.filter((p) => p.name === 'desktop'),
  // The servers' commands are written for apps/web, the config's own folder in the suite.
  webServer: (base.webServer as { cwd?: string }[]).map((s) => ({ ...s, cwd: web })) as never,
})
