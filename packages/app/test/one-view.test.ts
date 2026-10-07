// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// There is no Preview tab: the plate slices as it is edited, so Slice shows the slice in place. Its look is Solid,
// Layer lines or Toolpaths (the default, remembered), and whatever used to open Preview lands in Slice's toolpaths.
import type { PreviewBuffers } from '@slicerx/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { plateHandlers } from '../src/plate/keys'
import { loadPrefs } from '../src/state/prefs'
import { get, set, setWorkspace, showSliced, showsLayers } from '../src/state/store'

const PREVIEW = { layerCount: 3 } as unknown as PreviewBuffers

beforeEach(() => set({ workspace: 'prepare', modelMode: 'slice', sliceLook: 'toolpaths', preview: null }))
afterEach(() => localStorage.clear())

describe('the slice look', () => {
  it('is Toolpaths unless the person picked another, and a saved Preview opens Slice', () => {
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ workspace: 'preview' }))
    expect(loadPrefs()).toMatchObject({ workspace: 'prepare', sliceLook: 'toolpaths' })
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ sliceLook: 'print' }))
    expect(loadPrefs().sliceLook).toBe('print')
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ sliceLook: 'wireframe' }))
    expect(loadPrefs().sliceLook).toBe('toolpaths')
  })

  it('draws the layers only in Slice, with the toolpath look and a slice to show', () => {
    expect(showsLayers()).toBe(false)
    set({ preview: PREVIEW })
    expect(showsLayers()).toBe(true)
    set({ sliceLook: 'print' })
    expect(showsLayers()).toBe(false)
    set({ sliceLook: 'toolpaths', modelMode: 'design' })
    expect(showsLayers()).toBe(false)
    set({ modelMode: 'slice', workspace: 'printers' })
    expect(showsLayers()).toBe(false)
  })

  it('flips between the toolpaths and the solid models with the old Preview key', () => {
    const flip = plateHandlers()['workspace.toggle']!
    flip()
    expect(get().sliceLook).toBe('solid')
    flip()
    expect(get().sliceLook).toBe('toolpaths')
    set({ sliceLook: 'print' })
    flip()
    expect(get().sliceLook).toBe('toolpaths')
  })
})

describe('what opened Preview', () => {
  it('lands in Slice showing the toolpaths, from any tab or mode', () => {
    set({ workspace: 'printers', modelMode: 'design', sliceLook: 'solid' })
    setWorkspace('preview')
    expect(get()).toMatchObject({ workspace: 'prepare', modelMode: 'slice', sliceLook: 'toolpaths' })
    set({ workspace: 'library' })
    showSliced()
    expect(get().workspace).toBe('prepare')
  })
})
