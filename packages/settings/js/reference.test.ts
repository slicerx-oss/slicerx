// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SETTINGS } from './schema'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('docs/reference', () => {
  it('is in sync with schema.json', () => {
    const r = spawnSync('node', ['scripts/gen-reference.mjs', '--check'], { cwd: root, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  it('carries no help text copied from a slicer', () => {
    const base = readFileSync(root + 'docs/reference/process-strength.md', 'utf8')
    expect(base).not.toContain('extra wall to every other layer')
    expect(readFileSync(root + 'schema.json', 'utf8')).not.toContain('"help": "This is the')
  })

  it('mentions every key in the index and has no dashes or raw internal words', () => {
    const index = readFileSync(root + 'docs/reference/index.md', 'utf8')
    for (const d of SETTINGS) expect(index, d.key).toContain('`' + d.key + '`')
    const guide = readFileSync(root + 'docs/guide.md', 'utf8')
    for (const text of [index, guide]) expect(text).not.toMatch(/[\u2013\u2014]/)
  })
})
