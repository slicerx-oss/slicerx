// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The code that loads at startup reads the plates from plate/all-plates.ts, never plate/plates.ts: importing the plate
// edits from there put them, and the prime tower placement, back in the startup bundle (about 3.8 KB gzip).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = join(import.meta.dirname, '..', 'src')

describe('startup imports', () => {
  for (const file of ['project/unsaved.ts', 'export/upload-entry.ts']) {
    it(`${file} reads the plates without the plate edits`, () => {
      const text = readFileSync(join(src, file), 'utf8')
      expect(text).toMatch(/from '\.\.\/plate\/all-plates'/)
      expect(text).not.toMatch(/from '\.\.\/plate\/plates'/)
    })
  }
})
