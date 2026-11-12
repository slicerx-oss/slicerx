// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// A page that starts (a launch or a reload) tells the shell once, before its first model loads, so the shell lets go of
// the meshes and slices a page before it held: their ids went with that page.
import { describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({ calls: [] as string[], started: null as null | (() => void) }))

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: (m: unknown) => void = () => undefined
  },
  invoke: async (cmd: string) => {
    tauri.calls.push(cmd)
    if (cmd === 'slicer_page_start') return new Promise<null>((resolve) => (tauri.started = () => resolve(null)))
    if (cmd === 'load_mesh') return { id: 1, hash: 'h', name: 'cube.stl', triangles: 12, bboxMm: [1, 1, 1], parts: [] }
    return null
  },
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }))

const { createTauriSlicer, startSlicerPage } = await import('../src/host/slicer')

describe('a page start', () => {
  it('is sent once, and the first model loads only after the shell has let go of the old page', async () => {
    const first = startSlicerPage()
    const again = startSlicerPage()
    expect(again).toBe(first)
    const loading = createTauriSlicer().loadModel(new Uint8Array([1, 2, 3]).buffer, 'cube.stl')
    await new Promise((r) => setTimeout(r, 5))
    expect(tauri.calls).toEqual(['slicer_page_start'])
    tauri.started!()
    await expect(loading).resolves.toMatchObject({ id: '1' })
    expect(tauri.calls).toEqual(['slicer_page_start', 'load_mesh'])
  })
})
