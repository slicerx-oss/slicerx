// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A start approval is bound to the hash of the file that went up. These tests play the hub: they refuse a start
// whose params, hashed the way the host sees them, differ from what the card was approved for, or whose sha256 is
// not the hash of the exact bytes uploaded.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashParams, type ApprovalRequest, type Host, type JobFile, type RemoteFile } from '@slicerx/contracts'
import { sha256Hex } from '../src/calibration/gcode'
import { sendToPrinter, startQueued } from '../src/state/actions'
import { get, set } from '../src/state/store'

const printer = { id: 'p1', name: 'Bay 1', vendor: 'Test', model: 'T1', plugin: 'demo', nozzleCount: 1 } as never

function hub() {
  const requests = new Map<string, ApprovalRequest>()
  const uploaded: { name: string; hash: string }[] = []
  const started: RemoteFile[] = []
  const printers = {
    status: async () => ({ state: 'idle' }),
    upload: async (printerId: string, file: JobFile): Promise<RemoteFile> => {
      uploaded.push({ name: file.name, hash: await sha256Hex(file.data as ArrayBuffer) })
      return { printerId, path: `/${file.name}`, name: file.name }
    },
    start: async (file: RemoteFile, opts: unknown, token: { requestId: string }) => {
      const req = requests.get(token.requestId)!
      const action = req.actions.find((a) => a.action === 'printer.start')
      const seen = await hashParams({ printerId: file.printerId, name: file.name, opts, ...(file.sha256 ? { sha256: file.sha256 } : {}) })
      if (!action || action.paramsHash !== seen) throw new Error('start params do not match the approval (sha256 missing or different)')
      const up = uploaded.find((u) => u.name === file.name)
      if (up && file.sha256 !== up.hash) throw new Error('sha256 is not the hash of the uploaded bytes')
      started.push(file)
    },
  }
  const approvals = {
    register: async (r: ApprovalRequest) => void requests.set(r.id, r),
    grant: async (id: string) => ({ requestId: id }),
    deny: async () => undefined,
  }
  return { requests, uploaded, started, host: { kind: 'web', printers, approvals } as unknown as Host, printers }
}

beforeEach(() => set({ approval: null, printSheet: null, slice: { status: 'idle' } }))

describe('queued start', () => {
  const item = (sha256: string, remote: Partial<RemoteFile> = {}) => ({ id: 'q1', printerId: 'p1', printerName: 'Bay 1', plateName: 'Plate 1', remote: { printerId: 'p1', path: '/a.gcode', name: 'a.gcode', ...remote }, sha256, layers: 10, timeS: 600, grams: 3, options: {}, addedAt: new Date().toISOString() })

  async function run(h: ReturnType<typeof hub>, i: ReturnType<typeof item>) {
    const done = startQueued(h.host, i as never)
    await vi.waitFor(() => expect(get().approval).not.toBeNull())
    await get().approval!.approve()
    await done
  }

  it('carries the queue item\'s sha256 into the approval and the start', async () => {
    const h = hub()
    const sha = await sha256Hex(new TextEncoder().encode('G28').buffer as ArrayBuffer)
    h.uploaded.push({ name: 'a.gcode', hash: sha })
    await run(h, item(sha))
    expect(h.started).toHaveLength(1)
    expect(h.started[0]!.sha256).toBe(sha)
  })

  it('fails the start when the remote file has a hash that is not the uploaded bytes', async () => {
    const h = hub()
    const sha = await sha256Hex(new TextEncoder().encode('G28').buffer as ArrayBuffer)
    h.uploaded.push({ name: 'a.gcode', hash: sha })
    await run(h, item(sha, { sha256: 'f'.repeat(64) }))
    expect(h.started).toHaveLength(0)
  })
})

describe('send from the print sheet', () => {
  const gcode = 'G28\nG1 X10\n'
  const slice = {
    status: 'done',
    stale: false,
    result: { id: 'r1', layerCount: 5, warnings: [], stats: { timeS: 100, filamentG: [2], filamentMm: [600], cost: 0, toolChanges: 0 } },
  } as never

  async function send(h: ReturnType<typeof hub>, reported: string) {
    const blob = new Blob([gcode], { type: 'text/x-gcode' })
    const host = { ...h.host, slicer: { exportGcode: async () => ({ blob, bytes: blob.size, sha256: reported }) } } as unknown as Host
    set({ slice, plate: [] })
    const done = sendToPrinter(host, printer)
    await vi.waitFor(() => expect(get().printSheet?.check).toBeTruthy())
    get().printSheet!.resolve({ options: {}, start: true, name: 'plate_1.gcode' })
    await done
    return await sha256Hex(await blob.arrayBuffer())
  }

  it('binds the start to the hash of the bytes it uploaded', async () => {
    const h = hub()
    const real = await send(h, 'wrong')
    expect(h.uploaded).toHaveLength(1)
    expect(h.uploaded[0]!.hash).toBe(real)
    expect(h.started).toHaveLength(1)
    expect(h.started[0]!.sha256).toBe(real)
  })
})
