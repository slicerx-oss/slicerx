// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app link's sketch boxes: sketch.boxes reads the open sketch's boxes, sketch.box_set types a value into one, both
// refuse with no sketch open, and a bad call is refused before it reaches the sketch.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_LINK_METHODS, LinkError, runCall } from '../src/app-link/methods'
import { provideSketchBoxes, type SketchBoxesState } from '../src/cad/sketch-mode'

const state: SketchBoxesState = {
  dof: 4,
  shapes: [{ shape: 'rectangle', loop: 0, boxes: [{ box: 'width', label: 'Width', value: 20, unit: 'mm', set: null }, { box: 'height', label: 'Height', value: 10, unit: 'mm', set: null }] }],
  dimensions: [],
}
let release: (() => void) | null = null
afterEach(() => {
  release?.()
  release = null
})

const code = async (method: string, args: Record<string, unknown>) => {
  const e = await runCall(method, args).catch((x: unknown) => x)
  expect(e, JSON.stringify(args)).toBeInstanceOf(LinkError)
  return (e as LinkError).code
}

describe('app link sketch boxes', () => {
  it('reads the boxes and sets one as an edit', () => {
    expect(APP_LINK_METHODS['sketch.boxes']).toBe('read')
    expect(APP_LINK_METHODS['sketch.box_set']).toBe('edit')
  })

  it('says no sketch is open when none is', async () => {
    expect(await code('sketch.boxes', {})).toBe('not_found')
    expect(await code('sketch.box_set', { loop: 0, box: 'width', value: 5 })).toBe('not_found')
  })

  it('reads the open sketch and passes a set on, answering with the sketch read back', async () => {
    const set = vi.fn(async () => ({ ...state, dof: 3, driven: false }))
    release = provideSketchBoxes({ read: () => state, set })
    expect(await runCall('sketch.boxes', {})).toEqual(state)
    expect(await runCall('sketch.box_set', { loop: 0, box: 'width', value: 25 })).toMatchObject({ dof: 3, driven: false })
    expect(set).toHaveBeenLastCalledWith({ loop: 0, box: 'width', value: 25 })
    await runCall('sketch.box_set', { loop: 2, seg: 1, box: 'angle', value: '30+15' })
    expect(set).toHaveBeenLastCalledWith({ loop: 2, seg: 1, box: 'angle', value: '30+15' })
    await runCall('sketch.box_set', { loop: 0, box: 'height', value: null })
    expect(set).toHaveBeenLastCalledWith({ loop: 0, box: 'height', value: null })
  })

  it('refuses a bad call before the sketch sees it, and passes the sketch refusal on', async () => {
    const set = vi.fn(async () => {
      throw new Error('loop 4 has no boxes')
    })
    release = provideSketchBoxes({ read: () => state, set })
    for (const bad of [{ box: 'width', value: 1 }, { loop: -1, box: 'width', value: 1 }, { loop: 0, box: 'radius', value: 1 }, { loop: 0, box: 'width', value: Infinity }, { loop: 0, box: 'width', value: true }, { loop: 0, seg: 1.5, box: 'length', value: 1 }])
      expect(await code('sketch.box_set', bad)).toBe('invalid_input')
    expect(set).not.toHaveBeenCalled()
    expect(await code('sketch.box_set', { loop: 4, box: 'width', value: 1 })).toBe('invalid_input')
  })
})
