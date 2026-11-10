// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The code that loads at startup reads the plates from plate/all-plates.ts, never plate/plates.ts: importing the plate
// edits from there put them, and the prime tower placement, back in the startup bundle (about 3.8 KB gzip).
// lib/links.ts loads the printer catalog when a printer's page opens: a value import put every printer model in the
// startup bundle (about 8.6 KB gzip).
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

  it('lib/links.ts loads the printer catalog on first use', () => {
    const text = readFileSync(join(src, 'lib/links.ts'), 'utf8')
    expect(text).toMatch(/await import\('@slicerx\/printer-catalog'\)/)
    expect(text).not.toMatch(/^import \{[^}]*\} from '@slicerx\/printer-catalog'/m)
  })
})
