// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The agent bridge's memory report (app_state.memory): the bytes of every plate's meshes, each buffer counted once
// however many parts or plates share it, and the slice preview's.
import { describe, expect, it } from 'vitest'
import { pageMemory } from '../src/agent-bridge/page'
import type { AppState } from '../src/state/store'

describe('the page memory report', () => {
  it('counts each mesh buffer once across plates, and the preview', () => {
    const positions = new Float32Array(30)
    const indices = new Uint32Array(12)
    const part = { name: 'a', slot: 1, positions, indices }
    const other = { name: 'b', slot: 1, positions: new Float32Array(9), indices: new Uint32Array(3) }
    const s = {
      plate: [{ id: 'o1', parts: [part] }],
      activePlate: 'p1',
      plates: [
        { id: 'p1', objects: [] },
        { id: 'p2', objects: [{ id: 'o2', parts: [part, other], volumes: [{ part: other }] }] },
      ],
      historyEdit: null,
      preview: { raw: new ArrayBuffer(1000) },
    } as unknown as AppState
    expect(pageMemory(s)).toEqual({ meshBytes: 120 + 48 + 36 + 12, meshBuffers: 4, previewBytes: 1000 })
  })
})
