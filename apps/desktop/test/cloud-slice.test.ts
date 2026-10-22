// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
// Cloud slicing on the desktop, from an opened project: the project's objects load through the native slicer as
// always, and a slice with "Slice in the cloud" on uploads each of them and comes back with the cloud's G-code. Before,
// only the slice went to the cloud, which had no bytes for any model the app loaded and refused before sending anything.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host } from '@slicerx/contracts'

const tauri = vi.hoisted(() => ({ loads: [] as { name: string; bytes: Uint8Array }[], cmds: [] as string[] }))

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: (m: unknown) => void = () => undefined
  },
  invoke: async (cmd: string, args?: unknown, opts?: { headers?: Record<string, string> }) => {
    tauri.cmds.push(cmd)
    if (cmd === 'load_mesh') {
      const name = decodeURIComponent(opts?.headers?.['x-sx-name'] ?? '')
      tauri.loads.push({ name, bytes: new Uint8Array(args as Uint8Array) })
      return { id: tauri.loads.length, name, triangles: 12, hash: `h${tauri.loads.length}`, bboxMm: [20, 20, 20], parts: [{ name, slot: 1, triangles: 12 }] }
    }
    if (cmd === 'slice') throw new Error('the native engine was not meant to slice')
    return null
  },
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }))

const { createCloudClient, sha256Hex } = await import('@slicerx/cloud')
const { MOCK_GCODE, mockCloudService } = await import('../../../editions/slicerx/packages/cloud/test/mock-service')
const { withCloudSlicing } = await import('../src/host/cloud')
const { createTauriSlicer } = await import('../src/host/slicer')
const { openModelBytes, slicePlate } = await import('../../../packages/app/src/state/actions')
const { zip } = await import('../../../packages/app/src/export/zip')
const { profileReady } = await import('../../../packages/app/src/state/profile-sync')
const { get, set } = await import('../../../packages/app/src/state/store')

function cube(id: string, name: string): string {
  const v = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 20], [20, 0, 20], [20, 20, 20], [0, 20, 20]]
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]
  return `<object id="${id}" name="${name}" type="model"><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`
}

/** A plain 3MF project with two objects well apart. */
function project(): ArrayBuffer {
  const main = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${cube('1', 'Left')}${cube('2', 'Right')}</resources><build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 60 100 0"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 160 100 0"/></build></model>`
  const b = zip([{ name: '3D/3dmodel.model', data: main }])
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

beforeEach(async () => {
  tauri.loads.length = 0
  tauri.cmds.length = 0
  set((s) => ({ plate: [], plates: [{ ...s.plates[0]!, id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', projectSettings: null, projectPrinter: null, slice: { status: 'idle' }, toast: null }))
  await profileReady()
})

describe('cloud slicing on the desktop', () => {
  it('uploads an opened project and shows the G-code the cloud sliced', async () => {
    const svc = mockCloudService()
    const client = createCloudClient({ baseUrl: 'http://cloud.test', credential: () => 'session-token', fetch: svc.fetch })
    const { slicer } = withCloudSlicing(createTauriSlicer(), client, () => true)
    const host = { kind: 'desktop', capabilities: { threads: 1 }, slicer } as unknown as Host

    await openModelBytes(host, 'Two cubes.3mf', project(), undefined, { fresh: true })
    expect(get().plate.map((p) => p.name).sort()).toEqual(['Left', 'Right'])
    expect(tauri.loads).toHaveLength(2)

    await slicePlate(host)
    const state = get().slice
    expect(state.status, state.status === 'error' ? state.message : '').toBe('done')
    expect(tauri.cmds).not.toContain('slice')
    // Each object went up as the bytes the native engine loaded, and the job names them by hash.
    const shas = await Promise.all(tauri.loads.map((l) => sha256Hex(l.bytes)))
    expect([...svc.uploads.keys()].sort()).toEqual([...shas].sort())
    const objects = (svc.requests[0]!['plate'] as { objects: { name: string; mesh: string }[] }).objects
    expect(objects.map((o) => o.mesh).sort()).toEqual([...shas].sort())
    expect(svc.calls[0]).toEqual({ method: 'GET', path: '/v1/access' })
    // The G-code the app exports is the cloud's.
    const id = state.status === 'done' ? state.result.id : ''
    const out = await host.slicer.exportGcode(id, { kind: 'blob' })
    expect(await out.blob!.text()).toBe(MOCK_GCODE)
  })
})
