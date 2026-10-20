// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a new plate layout could not fit, said plainly: parts still off the bed apart from copies never added, and a
// geometry swap that leaves a part with no room on the bed says so in its notes.
import type { MeshPart } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { replaceGeometry } from '../skills/geom_common/index'
import { leftOffWords, type PilotProject } from '../src/index'

describe('what a layout could not fit', () => {
  it('says parts off the bed and copies not added apart', () => {
    expect(leftOffWords(undefined)).toBe('')
    expect(leftOffWords({ leftOff: 0, notAdded: 0 })).toBe('')
    expect(leftOffWords({ leftOff: 1 })).toBe('1 part is still off the bed because there is no room for it.')
    expect(leftOffWords({ leftOff: 0, notAdded: 3 })).toBe('3 copies did not fit, so they were not added.')
    expect(leftOffWords({ leftOff: 2, notAdded: 1 })).toBe('2 parts are still off the bed because there is no room for them. 1 copy did not fit, so it was not added.')
  })

  it('a geometry swap that leaves the part off the bed says so in its notes', async () => {
    const part: MeshPart = { name: 'Body', slot: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) } as unknown as MeshPart
    const project = {
      plates: () => [{ index: 1, items: [{ objectId: 'a', copies: 1 }] }],
      objects: () => [{ id: 'a', name: 'Big', bboxMm: [1, 1, 1] }],
      replaceObjects: async () => undefined,
      setPlates: () => ({ leftOff: 1 }),
    } as unknown as PilotProject
    const notes: string[] = []
    expect(await replaceGeometry(project, { id: 'a', name: 'Big', bboxMm: [1, 1, 1] }, [part], notes)).toBe(true)
    expect(notes).toEqual(['1 part is still off the bed because there is no room for it.'])
  })
})
