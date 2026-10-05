// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The phone's start approval is bound to the hash of the file it uploads. The hub below refuses a start whose params,
// hashed the way a host sees them, differ from the approved ones, or whose sha256 is not the hash of the uploaded bytes.
import { hashParams, type ApprovalRequest, type JobFile, type PrinterInfo, type RemoteFile } from '@slicerx/contracts'
import type { PocketHost } from '../host'
import { libraryModel, sliceAndSend } from './send'

const mockOutcome = { current: null as unknown }
jest.mock('../cloud/slice-job', () => ({ runCloudSlice: async () => mockOutcome.current }))
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
