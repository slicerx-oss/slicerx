// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A host that cannot slice (the CAD-only browser build) keeps the app in Model on the plate, whatever asks for Slice,
// and its Open in SlicerX link names the downloaded design by hash and file name only.
import { afterEach, describe, expect, it } from 'vitest'
import { cadShown, hostSlices, modelMode, setHostSlices, stayInModel, toggleModelMode } from '../src/state/model-mode'
import { openLink } from '../src/shell/open-in-app'
import { get, set } from '../src/state/store'

describe('the CAD-only build', () => {
  afterEach(() => setHostSlices(true))

  it('stays in Model on the plate', () => {
    setHostSlices(false)
    expect(hostSlices()).toBe(false)
    expect(cadShown()).toBe(true)
    set({ modelMode: 'slice', workspace: 'printers' })
    expect(modelMode()).toBe('design')
    const stop = stayInModel()
    expect(get().modelMode).toBe('design')
    expect(get().workspace).toBe('prepare')
    set({ modelMode: 'slice' })
    expect(get().modelMode).toBe('design')
    toggleModelMode()
    expect(get().modelMode).toBe('design')
    stop()
  })

  it('leaves a host that slices as it was', () => {
    set({ modelMode: 'slice', workspace: 'prepare' })
    toggleModelMode()
    expect(['design', 'slice']).toContain(get().modelMode)
    expect(hostSlices()).toBe(true)
  })

  it('links to the downloaded design by its hash and name', () => {
    expect(openLink('slicerx', 'ab'.repeat(32), 'My clip.sx3mf')).toBe(`slicerx://open?download=${'ab'.repeat(32)}&name=My%20clip.sx3mf`)
  })
})
