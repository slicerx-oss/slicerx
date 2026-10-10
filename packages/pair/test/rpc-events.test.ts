// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { EVENTS } from '../src/rpc'

describe('approval.resolved', () => {
  it('keeps the kind of client that answered, as sx-link sends it over the relay', () => {
    const r = EVENTS['approval.resolved'].parse({ requestId: 'r-1', decision: 'deny', by: 'LayerMate', via: 'partner' })
    expect(r).toEqual({ requestId: 'r-1', decision: 'deny', by: 'LayerMate', via: 'partner' })
  })

  it('still reads a host that names only who answered', () => {
    expect(EVENTS['approval.resolved'].parse({ requestId: 'r-1', decision: 'approve', by: 'this computer' })).toEqual({ requestId: 'r-1', decision: 'approve', by: 'this computer' })
  })
})
