// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The phone's start approval is bound to the hash of the file it uploads. The hub below refuses a start whose params,
// hashed the way a host sees them, differ from the approved ones, or whose sha256 is not the hash of the uploaded bytes.
import { hashParams, type ApprovalRequest, type JobFile, type PrinterInfo, type RemoteFile } from '@slicerx/contracts'
import type { PocketHost } from '../host'
import { CollisionStop, libraryModel, pickedFileProblem, sliceAndSend, STEP_ON_PHONE } from './send'

const mockOutcome = { current: null as unknown }
const mockSlices = { count: 0 }
jest.mock('../cloud/slice-job', () => ({ runCloudSlice: async () => (mockSlices.count++, mockOutcome.current) }))
jest.mock('../cloud/stub', () => ({ createCloudStub: () => ({}) }))
jest.mock('../cloud/stl', () => ({ boxStl: () => new ArrayBuffer(0) }))
jest.mock('../pair', () => ({ sendSlice: jest.fn(), sliceOnComputer: jest.fn() }))
jest.mock('./catalog', () => ({ useCatalog: () => ({}) }))
jest.mock('./provider', () => ({ usePocketHost: () => ({}) }))
jest.mock('./queries', () => ({ keys: {} }))
jest.mock('expo-document-picker', () => ({}), { virtual: true })
jest.mock('expo-file-system', () => ({ File: class {} }), { virtual: true })

const printer = { id: 'bay-1', name: 'Bay 1', vendor: 'Prusa', model: 'MK4', plugin: 'demo', nozzleCount: 1 } as PrinterInfo
const gcode = new TextEncoder().encode('G28\nG1 X10\n')

async function sha(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
}

function hub() {
  const requests = new Map<string, ApprovalRequest>()
  const uploaded: string[] = []
  const started: RemoteFile[] = []
  const host = {
    edition: { backend: {} },
    cloud: {},
    printers: {
      source: () => ({ kind: 'demo' }),
      upload: async (printerId: string, file: JobFile): Promise<RemoteFile> => {
        uploaded.push(await sha(file.data as ArrayBuffer))
        return { printerId, path: `/${file.name}`, name: file.name }
      },
      start: async (file: RemoteFile, opts: unknown, token: { requestId: string }) => {
        const action = requests.get(token.requestId)?.actions.find((a) => a.action === 'printer.start')
        const seen = await hashParams({ printerId: file.printerId, name: file.name, opts, ...(file.sha256 ? { sha256: file.sha256 } : {}) })
        if (!action || action.paramsHash !== seen) throw new Error('start params do not match the approval')
        if (file.sha256 !== uploaded[0]) throw new Error('sha256 is not the hash of the uploaded bytes')
        started.push(file)
      },
    },
    approvals: {
      register: async (r: ApprovalRequest) => void requests.set(r.id, r),
      grant: async (id: string) => ({ requestId: id }),
    },
  } as unknown as PocketHost
  return { host, started, uploaded }
}

const input = { model: { id: 'm', name: 'cube.stl', origin: 'file', load: async () => new ArrayBuffer(0) }, printer, easy: {}, material: 'pla' } as never

describe('phone send', () => {
  it('starts with the sha256 of the bytes it uploaded', async () => {
    const data = gcode.buffer.slice(0) as ArrayBuffer
    mockOutcome.current = { file: { name: 'cube.gcode', kind: 'gcode', data, sha256: await sha(data) }, layerCount: 5, timeS: 60, grams: 2 }
    const h = hub()
    await sliceAndSend(h.host, input, () => undefined)
    expect(h.started).toHaveLength(1)
    expect(h.started[0]!.sha256).toBe(h.uploaded[0])
  })

  it('refuses a file whose reported hash is not its bytes', async () => {
    const data = gcode.buffer.slice(0) as ArrayBuffer
    mockOutcome.current = { file: { name: 'cube.gcode', kind: 'gcode', data, sha256: 'e'.repeat(64) }, layerCount: 5, timeS: 60, grams: 2 }
    const h = hub()
    await expect(sliceAndSend(h.host, input, () => undefined)).rejects.toThrow(/sha256/)
    expect(h.started).toHaveLength(0)
  })
})

describe('a cloud slice with a collision', () => {
  const hit = { kind: 'hotend', severity: 'hit', part: 'toolhead', objectId: 'b', hitId: 'a', layer: 3, segment: 0, timeS: 9, lastLayer: 4, at: [0, 0, 1], point: [0, 0, 1], worstLayer: 3, worstPoint: [0, 0, 1], depthMm: 2, hitHeightMm: 10 }
  const outcome = async (collisions: unknown[]) => {
    const data = gcode.buffer.slice(0) as ArrayBuffer
    return { file: { name: 'cube.gcode', kind: 'gcode', data, sha256: await sha(data) }, layerCount: 5, timeS: 60, grams: 2, collisions }
  }

  it('stops before the approval on a hit, sending nothing, with the outcome to send later', async () => {
    mockOutcome.current = await outcome([hit])
    const h = hub()
    const err = await sliceAndSend(h.host, input, () => undefined).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CollisionStop)
    expect((err as CollisionStop).outcome).toBe(mockOutcome.current)
    expect(h.uploaded).toHaveLength(0)
    expect(h.started).toHaveLength(0)
  })

  it('goes on for a close call alone', async () => {
    mockOutcome.current = await outcome([{ ...hit, severity: 'close' }])
    const h = hub()
    await sliceAndSend(h.host, input, () => undefined)
    expect(h.started).toHaveLength(1)
  })

  it('sends the file of the stop when the person confirms again, with no second slice', async () => {
    const stopped = await outcome([hit])
    mockSlices.count = 0
    const h = hub()
    await sliceAndSend(h.host, input, () => undefined, undefined, stopped as never)
    expect(mockSlices.count).toBe(0)
    expect(h.started).toHaveLength(1)
    expect(h.started[0]!.sha256).toBe(h.uploaded[0])
  })
})

describe('libraryModel downloads', () => {
  const item = { listing: { id: 'l1', title: 'Clip', currentVersion: { id: 'v1', format: 'stl', sizeBytes: 10 } }, creator: { displayName: 'Maker' } } as never
  const store = (code: string, message = 'No') => ({ mode: 'live', download: async () => ({ ok: false, code, message }) }) as never

  it('has no sign-in message: a signed-out download goes through the store', async () => {
    await expect(libraryModel(item, store('not_signed_in', 'Sign in first')).load()).rejects.toThrow('Sign in first')
  })

  it('explains the per-network limit in plain words', async () => {
    await expect(libraryModel(item, store('rate_limited')).load()).rejects.toThrow('Too many downloads from this network')
  })
})

describe('picking a file on the phone', () => {
  it('sends a STEP file to desktop or web, since the phone has no STEP reader', () => {
    expect(STEP_ON_PHONE).toBe("STEP files can't be opened on the phone. Open this file on desktop or web.")
    for (const name of ['bracket.step', 'BRACKET.STP', 'assembly.stp']) expect(pickedFileProblem(name)).toBe(STEP_ON_PHONE)
  })

  it('takes STL, 3MF and OBJ, and names them for anything else', () => {
    for (const name of ['cube.stl', 'plate.3mf', 'part.OBJ']) expect(pickedFileProblem(name)).toBeNull()
    expect(pickedFileProblem('notes.txt')).toBe('Pick an STL, 3MF or OBJ file')
  })
})

