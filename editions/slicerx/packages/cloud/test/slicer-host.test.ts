// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Cloud slicing through the app's slicer: models the app loads reach the upload, and a cloud slice carries everything
// a local slice gets (options, per-object settings, volumes, brim ears), against the in-memory service stand-in.
import { describe, expect, it } from 'vitest'
import { type MeshHandle, type MeshPart, readPreview, type SliceOptions, type SliceRequest, type SlicerHost } from '@slicerx/contracts'
import { createCloudClient } from '../src/client'
import { sha256Hex } from '../src/hash'
import { cloudRoutedSlicer, createCloudSlicer, encodeParts } from '../src/slicer-host'
import { MOCK_GCODE, mockCloudService } from './mock-service'

/** A local slicer that hands out handles and records what it was asked to do. */
function fakeLocal() {
  let next = 1
  const released: string[] = []
  const sliced: SliceRequest[] = []
  const handle = (name: string): MeshHandle => ({ id: String(next++), hash: name, name, triangles: 1, bboxMm: [10, 10, 10], openEdges: 0, parts: [] })
  const local: SlicerHost = {
    loadModel: async (_data, name) => handle(name),
    loadParts: async (name) => handle(name),
    slice: async (req) => {
      sliced.push(req)
      throw new Error('the local engine was not meant to slice')
    },
    getPreview: async () => new ArrayBuffer(0),
    exportGcode: async () => ({ fileName: 'local.gcode', bytes: 0, sha256: '' }),
    release: (id) => void released.push(id),
  }
  return { local, released, sliced }
}

const part = (name: string, size = 10): MeshPart => ({
  name,
  slot: 1,
  positions: new Float32Array([0, 0, 0, size, 0, 0, 0, size, 0, 0, 0, size]),
  indices: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
})

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]
const plate = (objects: SliceRequest['plate']['objects']): SliceRequest['plate'] => ({ bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, objects })

function setup(enabled = true, encode?: (parts: MeshPart[]) => Uint8Array) {
  const svc = mockCloudService()
  const { local, released, sliced } = fakeLocal()
  const client = createCloudClient({ baseUrl: 'http://cloud.test', credential: () => 'session-token', fetch: svc.fetch })
  const cloud = createCloudSlicer({ client, local, pollMs: 1, ...(encode ? { encodeParts: encode } : {}) })
  const slicer = cloudRoutedSlicer({ local, cloud, enabled: () => enabled })
  return { svc, slicer, cloud, released, sliced }
}

describe('cloud slicing through the app slicer', () => {
  it('uploads the models the app loaded, painted copy included, and returns the G-code', async () => {
    const { svc, slicer, sliced } = setup()
    // An opened project loads each object's parts; a painted object slices with a copy loaded from its bytes.
    const body = await slicer.loadParts('Body', [part('Body')])
    const paintedBytes = new Uint8Array([0x53, 0x58, 0x4d, 0x50, 1, 2, 3, 4])
    const painted = await slicer.loadModel(paintedBytes.slice().buffer, 'Ears (painted)')
    const r = await slicer.slice({ plate: plate([{ id: 'a', name: 'Body', mesh: body.id, transform: T }, { id: 'b', name: 'Ears', mesh: painted.id, transform: T }]), config: { layer_height: 0.2 } as never, options: { emitGcode: true, emitPreview: true } })
    expect(sliced).toEqual([])
    // Access first, as the service expects, then the uploads, then the job.
    expect(svc.calls[0]).toEqual({ method: 'GET', path: '/v1/access' })
    const puts = svc.calls.filter((c) => c.method === 'PUT').map((c) => c.path)
    const bodySha = await sha256Hex(encodeParts([part('Body')]))
    const paintedSha = await sha256Hex(paintedBytes)
    expect(puts.sort()).toEqual([`/v1/meshes/${bodySha}`, `/v1/meshes/${paintedSha}`].sort())
    const objects = (svc.requests[0]!['plate'] as { objects: { mesh: string }[] }).objects
    expect(objects.map((o) => o.mesh)).toEqual([bodySha, paintedSha])
    expect(r.layerCount).toBe(1)
    const out = await slicer.exportGcode(r.id, { kind: 'blob' })
    expect(await out.blob!.text()).toBe(MOCK_GCODE)
    expect(readPreview(await slicer.getPreview(r.id)).layerCount).toBe(1)
  })

  it('slices on this device when cloud slicing is off, and sends nothing', async () => {
    const { svc, slicer, sliced } = setup(false)
    const h = await slicer.loadParts('Body', [part('Body')])
    await expect(slicer.slice({ plate: plate([{ id: 'a', name: 'Body', mesh: h.id, transform: T }]), config: {} as never })).rejects.toThrow('not meant to slice')
    expect(sliced).toHaveLength(1)
    expect(svc.calls).toEqual([])
  })

  it('uploads the local engine encoding when one is given, so paint goes too', async () => {
    const mine = (parts: MeshPart[]) => new Uint8Array([...encodeParts(parts), 0x53, 0x58, 0x50, 0x54])
    const { svc, slicer } = setup(true, mine)
    const h = await slicer.loadParts('Body', [part('Body')])
    await slicer.slice({ plate: plate([{ id: 'a', name: 'Body', mesh: h.id, transform: T }]), config: {} as never })
    expect([...svc.uploads.values()]).toEqual([mine([part('Body')])])
  })

  it('lets go of a cloud slice without asking the local slicer', async () => {
    const { slicer, released } = setup()
    const h = await slicer.loadParts('Body', [part('Body')])
    const r = await slicer.slice({ plate: plate([{ id: 'a', name: 'Body', mesh: h.id, transform: T }]), config: {} as never })
    slicer.release(r.id)
    expect(released).toEqual([])
    slicer.release(h.id)
    expect(released).toEqual([h.id])
  })
})

describe('what a cloud slice sends', () => {
  async function sent(options: SliceOptions, object: Partial<SliceRequest['plate']['objects'][number]> = {}, loadVolume = false) {
    const { svc, cloud } = setup()
    const h = await cloud.loadParts('Body', [part('Body')])
    const v = loadVolume ? await cloud.loadParts('Cut', [part('Cut', 4)]) : null
    const obj = { id: 'a', name: 'Body', mesh: h.id, transform: T, ...object, ...(v ? { volumes: [{ name: 'Cut', role: 'negative' as const, mesh: v.id }] } : {}) }
    await cloud.slice({ plate: plate([obj]), config: {} as never, options })
    return { request: svc.requests[0]!, svc }
  }
  const optionsOf = (r: Record<string, unknown>) => r['options'] as Record<string, unknown>
  const objectOf = (r: Record<string, unknown>) => (r['plate'] as { objects: Record<string, unknown>[] }).objects[0]!

  const OPTIONS: [keyof SliceOptions, unknown][] = [
    ['trustedGcode', true],
    ['layerGcode', [{ layer: 3, kind: 'pause' }, { zMm: 4.2, kind: 'custom', gcode: 'M117 band' }]],
    ['printerId', 'bambu-a1'],
    ['heightRanges', [{ zFromMm: 1, zToMm: 2, settings: { nozzle_temperature: 230 } }]],
    ['layerTopsMm', [0.2, 0.4, 0.56]],
    ['resumeFromLayer', 12],
    ['resumeZ', { mode: 'declare', zMm: 2.4 }],
    ['machineLimits', { nozzleMaxC: 300, bedMaxC: 110 }],
    ['nowUnix', 1_790_000_000],
    ['nowOffsetMinutes', 600],
    ['plateName', 'Plate 2'],
    ['plateNumber', 2],
    ['modelName', 'Widget'],
    ['flavor', 'klipper'],
    ['shards', 4],
    ['emitGcode', true],
    ['emitPreview', false],
  ]
  it.each(OPTIONS)('forwards the %s option', async (key, value) => {
    const { request } = await sent({ [key]: value } as SliceOptions)
    expect(optionsOf(request)[key]).toEqual(value)
    expect(optionsOf(request)['engine']).toBe('sx')
  })

  it('sends the thumbnail pixels as base64', async () => {
    const { request } = await sent({ thumbnail: { width: 1, height: 1, rgba: new Uint8Array([255, 0, 128, 255]) } })
    expect(optionsOf(request)['thumbnail']).toEqual({ width: 1, height: 1, rgba: '/wCA/w==' })
  })

  it("forwards an object's own settings", async () => {
    const { request } = await sent({}, { settings: { wall_loops: 4, sparse_infill_pattern: 'gyroid' } })
    expect(objectOf(request)['settings']).toEqual({ wall_loops: 4, sparse_infill_pattern: 'gyroid' })
  })

  it("forwards an object's part settings", async () => {
    const { request } = await sent({}, { partSettings: { Body: { wall_loops: 6 } } })
    expect(objectOf(request)['partSettings']).toEqual({ Body: { wall_loops: 6 } })
  })

  it("forwards an object's brim ears", async () => {
    const { request } = await sent({}, { brimPoints: [[1, 2, 0, 3]] })
    expect(objectOf(request)['brimPoints']).toEqual([[1, 2, 0, 3]])
  })

  it("forwards an object's slot overrides", async () => {
    const { request } = await sent({}, { slotOverrides: { Body: 2 } })
    expect(objectOf(request)['slotOverrides']).toEqual({ Body: 2 })
  })

  it("uploads an object's volumes and names them by hash", async () => {
    const { request, svc } = await sent({}, {}, true)
    const cut = await sha256Hex(encodeParts([part('Cut', 4)]))
    expect(objectOf(request)['volumes']).toEqual([{ name: 'Cut', role: 'negative', mesh: cut }])
    expect(svc.uploads.has(cut)).toBe(true)
  })
})

describe('the account check before uploading', () => {
  async function refused(access: Record<string, unknown>, parts = [part('Body')]) {
    const { svc, cloud } = setup()
    svc.access = access
    const h = await cloud.loadParts('Body', parts)
    const err = await cloud.slice({ plate: plate([{ id: 'a', name: 'Body', mesh: h.id, transform: T }]), config: {} as never }).then(() => null, (e: Error) => e.message)
    return { err, svc }
  }

  it('says so when the account is not invited, and uploads nothing', async () => {
    const { err, svc } = await refused({ invited: false })
    expect(err).toBe('This account is not invited to cloud slicing yet. Slice on this device instead.')
    expect(svc.calls).toEqual([{ method: 'GET', path: '/v1/access' }])
  })

  it('says so when the day is used up', async () => {
    const { err, svc } = await refused({ invited: true, jobsPerDay: 5, jobsToday: 5, maxUploadBytes: 1 << 20 })
    expect(err).toBe('This account has used all 5 cloud slices for the last 24 hours. Slice on this device instead.')
    expect(svc.uploads.size).toBe(0)
  })

  it('names the size and the limit when a model is over the upload limit', async () => {
    // About 0.2 MB of vertices against a 0.1 MB limit.
    const big = { ...part('Body'), positions: new Float32Array(3 * 17_476) }
    const { err, svc } = await refused({ invited: true, jobsPerDay: 5, jobsToday: 0, maxUploadBytes: 104_858 }, [big])
    expect(err).toBe("A model on this plate is 0.2 MB, over this account's cloud upload limit of 0.1 MB. Slice on this device instead.")
    expect(svc.uploads.size).toBe(0)
  })
})
