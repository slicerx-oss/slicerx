// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({ calls: [] as { cmd: string; headers: Record<string, string> }[] }))

// The webview's IPC builds a Headers object from these, which takes only characters up to U+00FF.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, _args?: unknown, options?: { headers?: Record<string, string> }) => {
    const headers = options?.headers ?? {}
    new Headers(headers)
    tauri.calls.push({ cmd, headers })
    if (cmd === 'load_mesh') return { id: 1, hash: 'h', name: '', triangles: 12, bboxMm: [0, 0, 0, 1, 1, 1], parts: [] }
    return null
  },
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }))

const { createTauriFiles } = await import('../src/host/files')
const { createTauriSlicer } = await import('../src/host/slicer')

beforeEach(() => {
  tauri.calls.length = 0
})

describe('file names cross the IPC percent-encoded', () => {
  const names = ['Кубик.stl', '立方体.3mf', 'Würfel 2.3mf', 'plain.stl']

  it('when a model loads', async () => {
    const slicer = createTauriSlicer()
    for (const name of names) {
      await slicer.loadModel(new Uint8Array([1, 2, 3]).buffer, name)
      const sent = tauri.calls.at(-1)!.headers['x-sx-name']!
      expect(sent).toMatch(/^[\x21-\x7e]*$/)
      expect(decodeURIComponent(sent)).toBe(name)
    }
  })

  it('when the save dialog suggests a name', async () => {
    const files = createTauriFiles()
    for (const name of names.map((n) => n.replace(/\.\w+$/, '.gcode'))) {
      await files.save(name, new Uint8Array([1]).buffer)
      const sent = tauri.calls.at(-1)!.headers['x-sx-name']!
      expect(sent).toMatch(/^[\x21-\x7e]*$/)
      expect(decodeURIComponent(sent)).toBe(name)
    }
  })
})
