// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Held layer keys in Preview on a slow machine: each press must settle in one render, or React counts every
// press as a nested update and throws "maximum update depth exceeded" (error 185) after about fifty of them.
import { createElement, Fragment } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, readPreview, type PreviewBuffers } from '@slicerx/contracts'
import { LayerStrip } from '../src/workspaces/layer-strip'
import { LayerDock } from '../src/workspaces/preview/preview-hud'
import { get, set, type ProfileInfo } from '../src/state/store'

/** `n` layers of four moves, the tool changing in each, 100 mm/s, 10 s a layer. */
function preview(n: number): PreviewBuffers {
  const S = n * 4
  const raw = new ArrayBuffer(SXPV_HEADER_BYTES + (n + 1) * 4 + n * 8 + S * SXPV_SEGMENT_BYTES)
  const dv = new DataView(raw)
  dv.setUint32(0, SXPV_MAGIC, true)
  dv.setUint16(4, SXPV_VERSION, true)
  dv.setUint32(8, S, true)
  dv.setUint32(12, n, true)
  dv.setUint32(20, 4, true)
  dv.setFloat32(24, 0.2, true)
  let o = SXPV_HEADER_BYTES
  for (let k = 0; k <= n; k++) dv.setUint32(o + k * 4, k * 4, true)
  o += (n + 1) * 4
  for (let k = 0; k < n; k++) dv.setFloat32(o + k * 4, 0.2 * (k + 1), true)
  o += n * 4
  for (let k = 0; k < n; k++) dv.setFloat32(o + k * 4, 10, true)
  o += n * 4
  for (let k = 0; k < n; k++)
    for (let i = 0; i < 4; i++) {
      dv.setFloat32(o, i * 10, true)
      dv.setFloat32(o + 8, i * 10 + 10, true)
      dv.setFloat32(o + 16, 0.2 * (k + 1), true)
      dv.setUint16(o + 20, 400, true)
      dv.setUint16(o + 22, 200, true)
      dv.setUint8(o + 25, (k + (i >> 1)) % 4)
      dv.setUint16(o + 26, 1000, true)
      o += SXPV_SEGMENT_BYTES
    }
  return readPreview(raw)
}

const profile = { printerId: 'snapmaker-u1', nozzle: 0.4, nozzles: [0.4], nozzleFrom: 'printer', tier: 'standard', source: 'orca' } as unknown as ProfileInfo

describe('Preview layer keys', () => {
  const errors: unknown[] = []
  const onError = (e: ErrorEvent) => {
    errors.push(e.error)
    e.preventDefault()
  }
  // Roots go even when a test fails, so a failed test's pending work cannot reach the next one.
  const roots: (() => void)[] = []
  afterEach(() => {
    for (const off of roots.splice(0)) off()
    window.removeEventListener('error', onError)
    vi.unstubAllGlobals()
    errors.length = 0
  })
  // The playback bar, and with `strip` the layer slider beside it, in one React root as Preview draws them.
  const mount = async (layerHi: number, layers = 150, strip = false) => {
    const p = preview(layers)
    if (strip) set({ slice: { status: 'done', stale: false, result: { layerZ: Array.from(p.layerZ), layerCount: layers } as never } })
    set({ preview: p, layerHi, moveCut: 1, toolChange: null, workspace: 'preview', settingsMode: 'advanced', profile, overrides: { nozzle_diameter: ['0.4', '0.4', '0.4', '0.4'], machine_tool_change_time: '5', travel_speed: '350' }, bed: { widthMm: 270, depthMm: 270, heightMm: 270 } })
    const el = document.createElement('div')
    document.body.append(el)
    const root = createRoot(el)
    root.render(strip ? createElement(Fragment, null, createElement(LayerDock), createElement(LayerStrip)) : createElement(LayerDock))
    await new Promise((r) => setTimeout(r, 50))
    let gone = false
    const done = () => {
      if (gone) return
      gone = true
      root.unmount()
      el.remove()
    }
    roots.push(done)
    return { el, done }
  }

  it('take a hundred presses before the next frame without a runaway update', async () => {
    window.addEventListener('error', onError)
    const { el, done } = await mount(150)
    const slider = el.querySelector('#pv-layer') as HTMLInputElement
    expect(slider).not.toBeNull()
    // Key repeat on a machine where a render takes longer than the repeat: every press lands before React's
    // scheduled (non-urgent) work gets a turn, as only microtasks run between them.
    for (let i = 0; i < 100; i++) {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      await Promise.resolve()
    }
    await new Promise((r) => setTimeout(r, 50))
    expect(errors.map(String)).toEqual([])
    expect(get().layerHi).toBe(50)
    done()
  })

  it('take the walk a scripted check makes on the Top layer handle, with no waits between keys', async () => {
    window.addEventListener('error', onError)
    const { el, done } = await mount(304, 304, true)
    const top = el.querySelector('[aria-label="Top layer"]') as HTMLElement
    expect(top).not.toBeNull()
    // As Playwright presses them: every key lands before React's scheduled work gets a turn.
    const press = async (key: string, n = 1) => {
      for (let i = 0; i < n; i++) {
        top.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
        await Promise.resolve()
      }
    }
    await press('Home')
    await press('ArrowRight', 303)
    await press('Home')
    await press('ArrowRight', 4)
    await press('ArrowRight', 150)
    await press('End')
    await new Promise((r) => setTimeout(r, 50))
    expect(errors.map(String)).toEqual([])
    expect(get().layerHi).toBe(304)
    done()
  })

  it('play through a hundred frames that come before the last render finished', async () => {
    window.addEventListener('error', onError)
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const { el, done } = await mount(1)
    const play = el.querySelector('button.play.primary') as HTMLButtonElement
    play.click()
    await new Promise((r) => setTimeout(r, 0))
    // Each frame plays 50 ms of print at the default speed; only microtasks run between frames.
    let at = performance.now()
    for (let i = 0; i < 100; i++) {
      const f = frames.shift()
      expect(f).toBeDefined()
      at += 50
      f!(at)
      await Promise.resolve()
    }
    await new Promise((r) => setTimeout(r, 50))
    expect(errors.map(String)).toEqual([])
    expect(get().layerHi).toBeGreaterThan(1)
    done()
  })
})
