// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A slice request names meshes by the pool's ids; a worker slices with its own. Volumes (negative volumes, support
// blockers and enforcers, modifiers) carry mesh ids too, and a worker that mapped only the objects' left them as the
// pool's ids, which the engine in the worker does not know: the slice failed with "unknown mesh id".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workerRequest } from '../../core/web/src/request-meshes'

const ROLES = ['negative', 'support_blocker', 'support_enforcer', 'modifier'] as const

function request(): string {
  return JSON.stringify({
    plate: { objects: [{ id: 'a', mesh: 'mesh-1', volumes: ROLES.map((role, i) => ({ name: role, role, mesh: `mesh-${i + 2}` })) }, { id: 'b', mesh: 'mesh-1' }] },
    config: {},
  })
}

describe('mesh ids in a worker request', () => {
  it('maps every object and every volume role to the worker ids', () => {
    const ids = new Map([['mesh-1', 7], ['mesh-2', 8], ['mesh-3', 9], ['mesh-4', 10], ['mesh-5', 11]])
    const out = JSON.parse(workerRequest(request(), (id) => ids.get(id)))
    expect(out.plate.objects[0].mesh).toBe(7)
    expect(out.plate.objects[0].volumes.map((v: { mesh: number }) => v.mesh)).toEqual([8, 9, 10, 11])
    expect(out.plate.objects[1].mesh).toBe(7)
    expect(out.config).toEqual({})
  })

  it('refuses a volume mesh the worker does not have, naming it', () => {
    const ids = new Map([['mesh-1', 1], ['mesh-2', 2]])
    expect(() => workerRequest(request(), (id) => ids.get(id))).toThrow('Mesh mesh-3 of volume support_blocker in object a is not loaded in this worker')
    expect(() => workerRequest(request(), () => undefined)).toThrow('Mesh mesh-1 of object a is not loaded in this worker')
  })
})

describe('the pool worker', () => {
  const posted: unknown[] = []
  const sliced: unknown[] = []
  beforeEach(() => {
    posted.length = 0
    sliced.length = 0
    vi.resetModules()
    let next = 0
    vi.doMock('../../core/web/src/wasm', () => ({
      OUT_GCODE: 0,
      OUT_SXPV: 1,
      SxWasm: {
        create: async () => ({
          loadMesh: () => ++next,
          releaseMesh: () => undefined,
          outJson: () => ({ id: next }),
          out: () => new Uint8Array(1),
          sliceShard: (req: Uint8Array) => void sliced.push(JSON.parse(new TextDecoder().decode(req))),
        }),
      },
    }))
    ;(globalThis as unknown as { self: unknown }).self = { postMessage: (m: unknown) => void posted.push(m), onmessage: null }
  })
  afterEach(() => {
    vi.doUnmock('../../core/web/src/wasm')
  })

  it('slices a request whose volumes name pool meshes with the ids it loaded them under', async () => {
    await import('../../core/web/src/worker')
    const self = (globalThis as unknown as { self: { onmessage: (ev: { data: unknown }) => Promise<void> } }).self
    await self.onmessage({ data: { type: 'init', module: {}, warmUp: false } })
    for (let i = 1; i <= 5; i++) await self.onmessage({ data: { type: 'load', call: i, meshId: `mesh-${i}`, fileName: 'x', data: new ArrayBuffer(1) } })
    await self.onmessage({ data: { type: 'slice', call: 9, request: request(), shard: 0, shards: 1 } })
    expect(posted.filter((m) => (m as { type: string }).type === 'error')).toEqual([])
    const req = sliced[0] as { plate: { objects: { mesh: number; volumes?: { mesh: number }[] }[] } }
    expect(req.plate.objects[0]!.mesh).toBe(1)
    expect(req.plate.objects[0]!.volumes!.map((v) => v.mesh)).toEqual([2, 3, 4, 5])
  })
})
