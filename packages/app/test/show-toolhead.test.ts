// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// "Show toolhead" in the playback bar: on by default, kept in the stored preferences, read back on launch.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, readPreview } from '@slicerx/contracts'
import { loadPrefs } from '../src/state/prefs'

const KEY = 'slicerx.prefs.v1'

/** One layer of two moves. */
function preview() {
  const raw = new ArrayBuffer(SXPV_HEADER_BYTES + 2 * 4 + 8 + 2 * SXPV_SEGMENT_BYTES)
  const dv = new DataView(raw)
  dv.setUint32(0, SXPV_MAGIC, true)
  dv.setUint16(4, SXPV_VERSION, true)
  dv.setUint32(8, 2, true)
  dv.setUint32(12, 1, true)
  dv.setUint32(20, 1, true)
  dv.setFloat32(24, 0.2, true)
  let o = SXPV_HEADER_BYTES
  dv.setUint32(o + 4, 2, true)
  o += 8
  dv.setFloat32(o, 0.2, true)
  dv.setFloat32(o + 4, 2, true)
  o += 8
  for (let i = 0; i < 2; i++) {
    const r = o + i * SXPV_SEGMENT_BYTES
    dv.setFloat32(r, i * 10, true)
    dv.setFloat32(r + 8, i * 10 + 10, true)
    dv.setFloat32(r + 16, 0.2, true)
    dv.setUint16(r + 26, 1000, true)
  }
  return readPreview(raw)
}

const fresh = async () => {
  vi.resetModules()
  return import('../src/state/store')
}

describe('Show toolhead', () => {
  beforeEach(() => localStorage.clear())

  it('reads as on when absent or not a boolean', () => {
    localStorage.setItem(KEY, JSON.stringify({ workspace: 'preview' }))
    expect(loadPrefs().showToolhead).toBe(true)
    localStorage.setItem(KEY, JSON.stringify({ showToolhead: 'no' }))
    expect(loadPrefs().showToolhead).toBe(true)
    localStorage.setItem(KEY, JSON.stringify({ showToolhead: false }))
    expect(loadPrefs().showToolhead).toBe(false)
  })

  it('is on by default, and the checkbox next to the playback controls turns it off for the next launch', async () => {
    const store = await fresh()
    expect(store.get().showToolhead).toBe(true)
    const { LayerDock } = await import('../src/workspaces/preview/preview-hud')
    store.set({ preview: preview(), layerHi: 1, moveCut: 1, toolChange: null, workspace: 'preview' })
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    flushSync(() => root.render(createElement(LayerDock)))
    const label = [...el.querySelectorAll('.dock-h label')].find((l) => l.textContent?.trim() === 'Show toolhead')
    expect(label).toBeDefined()
    const box = label!.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box.checked).toBe(true)
    flushSync(() => box.click())
    expect(store.get().showToolhead).toBe(false)
    expect(box.checked).toBe(false)
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').showToolhead).toBe(false)
    flushSync(() => root.unmount())
    el.remove()
    expect((await fresh()).get().showToolhead).toBe(false)
  })
})
