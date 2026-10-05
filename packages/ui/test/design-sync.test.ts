// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('design copies', () => {
  it('design/tokens.css and design/icons.js are the generated copies of the package sources', () => {
    const script = resolve(__dirname, '../../../design/sync.mjs')
    expect(() => execFileSync('node', [script, '--check'], { stdio: 'pipe' })).not.toThrow()
  })
})
