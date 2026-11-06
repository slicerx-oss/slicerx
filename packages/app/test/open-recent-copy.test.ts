// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A project file opened from disk is kept as a recent project (autosave.ts, recordRecent), which stores nothing over
// MAX_SNAPSHOT_BYTES. The copy taken for it is made only when it can be kept: a bigger project is not copied at all, so
// its open does not hold a second copy of the file for nothing.
import { describe, expect, it } from 'vitest'
import { MAX_SNAPSHOT_BYTES } from '../src/project/autosave'
import { recentCopy } from '../src/state/open-models'

describe('the copy of an opened project kept for recents', () => {
  it('is a copy of a project within the snapshot limit', () => {
    const data = new Uint8Array([1, 2, 3]).buffer
    const keep = recentCopy('a.3mf', data, false)
    expect(keep).not.toBe(data)
    expect([...new Uint8Array(keep!)]).toEqual([1, 2, 3])
  })

  it('is not made for a project over the snapshot limit', () => {
    expect(recentCopy('big.3mf', new ArrayBuffer(MAX_SNAPSHOT_BYTES + 1), false)).toBeNull()
  })

  it('is not made for a mesh file or an unlocked project', () => {
    expect(recentCopy('part.stl', new ArrayBuffer(8), false)).toBeNull()
    expect(recentCopy('a.sx3mf', new ArrayBuffer(8), true)).toBeNull()
  })
})
