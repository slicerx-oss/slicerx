// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { hashParams, type ApprovalRequest, type ApprovalToken, type JobFile, type RemoteFile } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import type { CloudClient } from '../src/client'
import { createDeliveryAgent, type DeliveryEvent } from '../src/delivery'
import { sha256Hex } from '../src/hash'
import { fail, ok } from '../src/result'
import type { Delivery, DeliveryState } from '../src/schemas'

const DEVICE = '00000000-0000-4000-8000-00000000d001'

async function setup(opts: { tamper?: boolean } = {}) {
  const gcode = new TextEncoder().encode('G28\nG1 X10\n')
  const sha = await sha256Hex(gcode)
  let d: Delivery = {
    id: '00000000-0000-4000-8000-000000000d11',
    jobId: '00000000-0000-4000-8000-000000000011',
    printerId: '00000000-0000-4000-8000-000000000021',
    printerLocalId: 'bay-1',
    state: 'offered',
    message: null,
    fileName: 'Bracket.gcode',
    sha256: sha,
    bytes: gcode.length,
    gcodePath: '/v1/jobs/00000000-0000-4000-8000-000000000011/gcode',
    stats: { timeS: 1800, filamentG: 12.5 },
    createdAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-02T00:00:00Z',
  }
  const states: DeliveryState[] = []
  const client = {
    deliveries: () => Promise.resolve(ok(['offered', 'downloaded', 'awaiting_approval'].includes(d.state) ? [d] : [])),
    setDeliveryState: (_dev: string, _id: string, state: DeliveryState, message?: string) => {
      states.push(state)
      d = { ...d, state, message: message ?? null }
      return Promise.resolve(ok(d))
    },
    downloadDelivery: async (x: Delivery) => {
      const data = opts.tamper ? new TextEncoder().encode('G28\nM104 S300\n') : gcode
      return (await sha256Hex(data)) === x.sha256 ? ok(data) : fail('hash_mismatch', 'the downloaded file does not match')
    },
  } as unknown as CloudClient

  const registered: ApprovalRequest[] = []
  const denied: string[] = []
  const uploads: { printerId: string; file: JobFile; token: ApprovalToken }[] = []
  const starts: { file: RemoteFile; token: ApprovalToken }[] = []
  const events: DeliveryEvent[] = []
  const agent = createDeliveryAgent({
    client,
    deviceId: DEVICE,
    printers: {
      upload: (printerId, file, token) => {
        uploads.push({ printerId, file, token })
        return Promise.resolve({ printerId, path: `/gcodes/${file.name}`, name: file.name })
      },
      start: (file, _opts, token) => {
        starts.push({ file, token })
        return Promise.resolve()
      },
    },
    approvals: {
      register: (r) => {
        registered.push(r)
        return Promise.resolve()
      },
      deny: (id) => {
        denied.push(id)
        return Promise.resolve()
      },
    },
    printerId: (local) => (local === 'bay-1' ? 'printer-bay-1' : null),
    onEvent: (e) => events.push(e),
    now: () => new Date('2026-01-01T00:00:00Z'),
  })
  return { agent, states, registered, denied, uploads, starts, events, sha }
}

const token: ApprovalToken = { requestId: 'r', token: 'minted-locally', expiresAt: '2026-01-01T00:05:00Z' }

describe('delivery agent', () => {
  it('downloads, asks for approval and touches no printer before it', async () => {
    const t = await setup()
    await t.agent.tick()
    expect(t.states).toEqual(['downloaded', 'awaiting_approval'])
    expect(t.uploads).toEqual([])
    const req = t.registered[0]
    expect(req?.printerId).toBe('printer-bay-1')
    expect(req?.permission).toBe('start')
    expect(req?.actions.map((a) => a.action)).toEqual(['printer.upload', 'printer.start'])
    expect(t.events[0]?.type).toBe('approval_needed')

    // A second poll does not ask twice.
    await t.agent.tick()
    expect(t.registered).toHaveLength(1)

    // An approval without the locally minted token does nothing.
    await t.agent.resolve(req?.id ?? '', { kind: 'approve' })
    expect(t.uploads).toEqual([])
  })

  it('prints with the minted token once the user approves', async () => {
    const t = await setup()
    await t.agent.tick()
    await t.agent.resolve(t.registered[0]?.id ?? '', { kind: 'approve', token })
    expect(t.uploads).toHaveLength(1)
    expect(t.uploads[0]?.file.sha256).toBe(t.sha)
    expect(t.uploads[0]?.token).toBe(token)
    expect(t.starts[0]?.token).toBe(token)
    expect(t.states).toEqual(['downloaded', 'awaiting_approval', 'approved', 'uploaded', 'printing'])
  })

  it('binds the start to the hash of the bytes it uploaded', async () => {
    const t = await setup()
    await t.agent.tick()
    const req = t.registered[0]!
    await t.agent.resolve(req.id, { kind: 'approve', token })
    const up = t.uploads[0]!.file
    const start = t.starts[0]!.file
    // The start carries the hash of the exact bytes that went up, and the approval was made for that hash.
    expect(start.sha256).toBe(await sha256Hex(new Uint8Array(up.data as ArrayBuffer)))
    const seen = await hashParams({ printerId: start.printerId, name: start.name, opts: {}, sha256: start.sha256 })
    expect(req.actions.find((a) => a.action === 'printer.start')?.paramsHash).toBe(seen)
    // A start without sha256 hashes differently, so a hub that requires it would refuse it.
    expect(await hashParams({ printerId: start.printerId, name: start.name, opts: {} })).not.toBe(seen)
  })

  it('records a decline and sends nothing', async () => {
    const t = await setup()
    await t.agent.tick()
    await t.agent.resolve(t.registered[0]?.id ?? '', { kind: 'deny', reason: 'wrong filament loaded' })
    expect(t.denied).toHaveLength(1)
    expect(t.uploads).toEqual([])
    expect(t.states.at(-1)).toBe('declined')
  })

  it('fails a delivery whose file does not match its hash', async () => {
    const t = await setup({ tamper: true })
    await t.agent.tick()
    expect(t.registered).toEqual([])
    expect(t.states).toEqual(['failed'])
  })
})
