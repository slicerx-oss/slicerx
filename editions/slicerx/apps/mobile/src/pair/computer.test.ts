// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { EasySettings, PrinterInfo } from '@slicerx/contracts'
import type { PocketHost } from '../host'
import type { PhoneModel, SlicePhase } from '../cloud/slice-job'
import { sendSlice, sliceOnComputer } from './computer'

const mockSvc = { hosts: jest.fn(), connection: jest.fn(), printers: jest.fn() }
// The real package pulls in ESM-only crypto that jest does not load; the tests need only its error type.
jest.mock('@slicerx/pair', () => ({
  PairError: class PairError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
}))
jest.mock('./service', () => ({ pairService: () => Promise.resolve(mockSvc) }))

const printer = { id: 'bay-1', name: 'Bay 1', vendor: 'Bambu', model: 'X1C' } as PrinterInfo
const easy = { goal: 'quality', supports: 'none', brim: false } as unknown as EasySettings
const bytes = new Uint8Array([1, 2, 3]).buffer
const model = (name: string): PhoneModel => ({ id: 'm', name, origin: 'file', load: async () => bytes })

const pocket = (source: unknown) => ({ printers: { source: () => source } }) as unknown as PocketHost
const PAIRED = { kind: 'paired', hostId: 'h1', hostName: 'Studio Mac' }

function connection(slicing: string[] = ['host']) {
  return {
    info: { identity: { name: 'Studio Mac' }, slicing },
    uploadModel: jest.fn(() => Promise.resolve('blob-1')),
    slice: jest.fn((_req: unknown, onProgress?: (s: string, f: number) => void) => {
      onProgress?.('slicing', 0.5)
      onProgress?.('not-a-stage', 0.9)
      return Promise.resolve({ sliceId: 's1', name: 'cube.gcode', sha256: 'ab'.repeat(32), layers: 100, timeS: 3600, grams: 12.5 })
    }),
  }
}

beforeEach(() => {
  mockSvc.hosts.mockReset().mockReturnValue([{ host: { hostId: 'h1', pairingId: 'p1' } }])
  mockSvc.connection.mockReset()
  mockSvc.printers.mockReset()
})

describe('sliceOnComputer', () => {
  it('uploads the model, slices with the phone settings and reports phases', async () => {
    const conn = connection()
    mockSvc.connection.mockResolvedValue(conn)
    const phases: SlicePhase[] = []
    const out = await sliceOnComputer(pocket(PAIRED), { model: model('cube.stl'), printer, easy, material: 'pla' }, (p) => phases.push(p))
    expect(conn.uploadModel).toHaveBeenCalledWith({ name: 'cube.stl', kind: 'stl', data: new Uint8Array([1, 2, 3]), printerId: 'bay-1' })
    expect(conn.slice.mock.calls[0]?.[0]).toEqual({ source: { kind: 'blob', blobId: 'blob-1' }, where: 'host', printerId: 'bay-1', options: { material: 'pla', easy } })
    expect(phases.map((p) => p.kind)).toEqual(['uploading', 'queued', 'slicing', 'slicing'])
    // An unknown stage from a newer computer falls back to a known one instead of breaking the bar.
    expect(phases[3]).toMatchObject({ kind: 'slicing', stage: 'layers', fraction: 0.9 })
    expect(out).toEqual({ sliceId: 's1', file: { name: 'cube.gcode', sha256: 'ab'.repeat(32) }, layerCount: 100, timeS: 3600, grams: 12.5 })
  })

  it('sends 3MF files as 3mf', async () => {
    const conn = connection()
    mockSvc.connection.mockResolvedValue(conn)
    await sliceOnComputer(pocket(PAIRED), { model: model('Plate.3MF'), printer, easy, material: 'petg' }, () => undefined)
    expect(conn.uploadModel).toHaveBeenCalledWith(expect.objectContaining({ kind: '3mf' }))
  })

  it('refuses without a paired computer as the printer source', async () => {
    await expect(sliceOnComputer(pocket({ kind: 'demo' }), { model: model('a.stl'), printer, easy, material: 'pla' }, () => undefined)).rejects.toThrow('Pair a computer to slice on it')
  })

  it('refuses when the computer was unpaired meanwhile', async () => {
    mockSvc.hosts.mockReturnValue([])
    await expect(sliceOnComputer(pocket(PAIRED), { model: model('a.stl'), printer, easy, material: 'pla' }, () => undefined)).rejects.toThrow('no longer paired')
  })

  it('refuses a computer that cannot slice, before uploading anything', async () => {
    const conn = connection(['cloud'])
    mockSvc.connection.mockResolvedValue(conn)
    await expect(sliceOnComputer(pocket(PAIRED), { model: model('a.stl'), printer, easy, material: 'pla' }, () => undefined)).rejects.toThrow('cannot slice')
    expect(conn.uploadModel).not.toHaveBeenCalled()
  })

  it('refuses file types the computer does not slice', async () => {
    mockSvc.connection.mockResolvedValue(connection())
    await expect(sliceOnComputer(pocket(PAIRED), { model: model('a.obj'), printer, easy, material: 'pla' }, () => undefined)).rejects.toThrow('STL and 3MF')
  })

  it('stops after the upload when canceled and never starts a slice', async () => {
    const conn = connection()
    mockSvc.connection.mockResolvedValue(conn)
    const ctl = new AbortController()
    conn.uploadModel.mockImplementation(() => {
      ctl.abort()
      return Promise.resolve('blob-1')
    })
    await expect(sliceOnComputer(pocket(PAIRED), { model: model('a.stl'), printer, easy, material: 'pla' }, () => undefined, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(conn.slice).not.toHaveBeenCalled()
  })
})

describe('sendSlice', () => {
  it('hands the slice, printer and the phone token to the computer and starts it', async () => {
    const sendSliceCall = jest.fn(() => Promise.resolve())
    mockSvc.connection.mockResolvedValue(connection())
    mockSvc.printers.mockReturnValue({ sendSlice: sendSliceCall })
    const token = { id: 't' } as never
    await sendSlice(pocket(PAIRED), 's1', printer, token)
    expect(mockSvc.printers).toHaveBeenCalledWith('p1')
    expect(sendSliceCall).toHaveBeenCalledWith('s1', 'bay-1', token, { start: true })
  })
})
