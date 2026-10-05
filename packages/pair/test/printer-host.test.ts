// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { hashParams, type ApprovalToken, type JobFile, type SideEffectAction } from '@slicerx/contracts'
import { createApprovalBroker } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { toArrayBuffer, toHex } from '../src/bytes'
import { sha256 } from '../src/crypto'
import { createPairedPrinterHost } from '../src/printer-host'
import type { ApprovalView } from '../src/rpc'
import { flush, pairByLink, world } from './helpers'

const bytes = new TextEncoder().encode('; phone slice\nG28\n')
const FILE: JobFile = { name: 'clip.gcode', kind: 'gcode', data: toArrayBuffer(bytes), sha256: toHex(sha256(bytes)) }

let seq = 0
/** What the phone app does after Face ID: register its own request and mint a token. */
async function localApproval(broker: ReturnType<typeof createApprovalBroker>, actions: { action: SideEffectAction; target: string; params: unknown }[]): Promise<ApprovalToken> {
  const id = `local-${++seq}`
  await broker.register({
    id,
    sessionId: 'pocket',
    tool: 'printer.send',
    permission: 'start',
    title: 'Send',
    lines: [],
    paramsHash: await hashParams(actions.map((a) => a.params)),
    actions: await Promise.all(actions.map(async (a) => ({ action: a.action, target: a.target, paramsHash: await hashParams(a.params) }))),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  return broker.grant(id)
}

const sendActions = (printerId: string, name = FILE.name) => [
  { action: 'printer.upload' as const, target: printerId, params: { printerId, name, sha256: FILE.sha256 } },
  { action: 'printer.start' as const, target: printerId, params: { printerId, name, opts: {}, sha256: FILE.sha256 } },
]

async function setup() {
  const w = await world()
  const phone = w.phone('Pocket')
  await pairByLink(w, phone)
  const conn = await phone.client.connect((await phone.client.hosts())[0]?.pairingId ?? '')
  const local = createApprovalBroker()
  const printers = createPairedPrinterHost({ connection: async () => conn, local, jobTimeoutMs: 3000 })
  return { w, conn, local, printers }
}

describe('paired PrinterHost', () => {
  it('reads printers and runs upload then start under one phone approval', async () => {
    const { w, conn, local, printers } = await setup()
    expect((await printers.list()).map((p) => p.id)).toContain('bay-2')
    // The computer announces its request before it answers the call; the adapter still claims it.
    const claimed: Promise<boolean>[] = []
    conn.on('approval.request', (v) => claimed.push(printers.ownsSettled(v.request.id)))
    const token = await localApproval(local, sendActions('bay-2'))
    const remote = await printers.upload('bay-2', FILE, token)
    expect(await Promise.all(claimed)).toEqual([true])
    expect(remote).toMatchObject({ printerId: 'bay-2', name: 'clip.gcode' })
    expect((await w.sim.status('bay-2')).state).toBe('idle')
    await printers.start(remote, {}, token)
    expect((await w.sim.status('bay-2')).state).not.toBe('idle')
    expect(w.host.audit().map((a) => a.decision)).toEqual(['approve', 'approve'])
  })

  it('refuses when the phone approval was for something else, and denies the computer request', async () => {
    const { w, local, printers, conn } = await setup()
    const token = await localApproval(local, sendActions('bay-1'))
    const denied: string[] = []
    conn.on('approval.resolved', (r) => denied.push(r.decision))
    await expect(printers.upload('bay-2', FILE, token)).rejects.toMatchObject({ code: 'approval_invalid' })
    await flush()
    expect(denied).toEqual(['deny'])
    expect((await w.sim.status('bay-2')).state).toBe('idle')
  })

  it('a phone token works once', async () => {
    const { local, printers } = await setup()
    const token = await localApproval(local, sendActions('bay-2'))
    await printers.upload('bay-2', FILE, token)
    await expect(printers.upload('bay-2', FILE, token)).rejects.toMatchObject({ code: 'approval_invalid' })
  })

  it('a forged token from outside the phone broker is refused', async () => {
    const { printers } = await setup()
    await expect(printers.upload('bay-2', FILE, { requestId: 'x', token: 'forged', expiresAt: '' })).rejects.toMatchObject({ code: 'approval_invalid' })
  })

  it('without the approve right, the computer card decides', async () => {
    const { w, local, conn } = await setup()
    const [d] = await w.host.devices()
    await w.host.setRights(d?.pairingId ?? '', { request: true, approve: false, introduce: false })
    await flush()
    const reconnected = { ...conn, info: { ...conn.info, rights: { request: true, approve: false, introduce: false } } }
    const p2 = createPairedPrinterHost({ connection: async () => reconnected, local, jobTimeoutMs: 3000 })
    const seen: ApprovalView[] = []
    w.host.jobApprovals.onRequest((v) => seen.push(v))
    const token = await localApproval(local, sendActions('bay-2'))
    const pending = p2.upload('bay-2', FILE, token)
    for (let i = 0; i < 50 && seen.length === 0; i++) await flush(2)
    expect(p2.owns(seen[0]?.request.id ?? '')).toBe(true)
    await w.host.jobApprovals.decide(seen[0]?.request.id ?? '', { kind: 'approve' })
    await expect(pending).resolves.toMatchObject({ printerId: 'bay-2' })
  })

  it('pause and cancel go through the same approval', async () => {
    const { w, local, printers } = await setup()
    const token = await localApproval(local, [
      { action: 'printer.pause', target: 'bay-1', params: { printerId: 'bay-1' } },
      { action: 'printer.cancel', target: 'bay-1', params: { printerId: 'bay-1' } },
    ])
    await printers.pause('bay-1', token)
    expect((await w.sim.status('bay-1')).state).toBe('paused')
    await printers.cancel('bay-1', token)
    expect((await w.sim.status('bay-1')).state).not.toBe('printing')
  })

  it('sends a plate the computer sliced', async () => {
    const { w, conn, local, printers } = await setup()
    const slice = await conn.slice({ source: { kind: 'library', id: 'lib-1' }, where: 'host' })
    const token = await localApproval(local, [
      { action: 'printer.upload', target: 'bay-2', params: { printerId: 'bay-2', name: slice.name, sha256: slice.sha256 } },
      { action: 'printer.start', target: 'bay-2', params: { printerId: 'bay-2', name: slice.name, opts: {}, sha256: slice.sha256 } },
    ])
    await printers.sendSlice(slice.sliceId, 'bay-2', token, { start: true })
    expect((await w.sim.status('bay-2')).state).not.toBe('idle')
  })

  it('fleet changes stay on the computer', async () => {
    const { printers } = await setup()
    await expect(printers.createFleet('New')).rejects.toMatchObject({ code: 'not_supported' })
  })
})
