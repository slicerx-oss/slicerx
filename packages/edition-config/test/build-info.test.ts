// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCommit, resolveCommit } from '../src/build-info.ts'

const none = { env: null, git: () => null, file: () => null, serve: false }
const HASH = 'a7d0118b0c1d2e3f4a5b6c7d8e9f001122334455'

describe('build commit', () => {
  it('takes the environment first, then git, then the BUILD_COMMIT file', () => {
    expect(resolveCommit({ ...none, env: 'abc1234', git: () => HASH })).toBe('abc1234')
    expect(resolveCommit({ ...none, git: () => `${HASH}\n`, file: () => 'bbbbbbb' })).toBe(HASH)
    expect(resolveCommit({ ...none, file: () => 'bbbbbbb\n' })).toBe('bbbbbbb')
  })

  it('never says dev in a production build', () => {
    expect(() => resolveCommit(none)).toThrow(/SLICERX_COMMIT/)
    expect(() => resolveCommit({ ...none, git: () => 'not a hash' })).toThrow()
    expect(resolveCommit({ ...none, env: 'dev' })).toBe('dev')
  })

  it('falls back to dev only for the dev server', () => {
    expect(resolveCommit({ ...none, serve: true })).toBe('dev')
  })

  it('rejects an environment value that is not a hash', () => {
    expect(() => resolveCommit({ ...none, env: 'v1.0' })).toThrow(/commit hash/)
  })

  it('reads the BUILD_COMMIT file of a tree that has no .git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sx-build-'))
    expect(() => buildCommit(dir, false, {})).toThrow()
    writeFileSync(join(dir, 'BUILD_COMMIT'), `${HASH}\n`)
    expect(buildCommit(dir, false, {})).toBe(HASH)
  })
})
