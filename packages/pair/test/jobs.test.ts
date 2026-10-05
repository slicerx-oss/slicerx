// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ApprovalRequest } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { signDecision } from '../src/approval'
import { fromB64url, toB64url } from '../src/bytes'
import { createIdentity } from '../src/identity'
import { createRpcPeer } from '../src/rpc'
import { openSession } from '../src/session'
import { memoryPipePair } from '../src/transport'
import type { HostConnection } from '../src/client'
import type { ApprovalView, JobUpdate } from '../src/rpc'
import { flush, pairByLink, world, type Phone, type World } from './helpers'

const GCODE = new TextEncoder().encode('; phone slice\nG28\nG1 X10 Y10\n')

async function connected(w: World, phone: Phone): Promise<HostConnection> {
  await pairByLink(w, phone)
  const [host] = await phone.client.hosts()
  return phone.client.connect(host?.pairingId ?? '')
}

function collect(conn: HostConnection) {
  const jobs: JobUpdate[] = []
  const approvals: ApprovalView[] = []
  conn.onJob((u) => jobs.push(u))
  conn.on('approval.request', (v) => approvals.push(v))
  return { jobs, approvals }
}

/** A second session for the same phone, for sending requests the typed client never would. */
async function rawRpc(w: World, phone: Phone) {
  const [rec] = await phone.store.list()
  const key = fromB64url(rec?.deviceKey ?? '')
  const hostDhPub = fromB64url(rec?.peer.dhPub ?? '')
  if (!key || !hostDhPub) throw new Error('no pairing')
  const [a, b] = memoryPipePair()
  w.host.handlePipe(b)
  const rpc = createRpcPeer(await openSession(a, { env: w.env, deviceKey: key, hostDhPub }))
  await rpc.call('host.info', {})
  return rpc
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await flush(2)
  if (!check()) throw new Error('condition not reached')
}

describe('print jobs from the phone', () => {
  it('nothing reaches the printer until the phone approves, then it uploads and starts', async () => {
    const w = await world()
    const conn = await connected(w, w.phone('Pocket'))
    const seen = collect(conn)
    const slice = await conn.uploadSlice({ name: 'clip.gcode', kind: 'gcode', data: GCODE, stats: { timeS: 600 } })
    expect(slice.where).toBe('phone')
    const { requestId } = await conn.send({ sliceId: slice.sliceId, target: { printerIds: ['bay-2'] }, start: true })
    await waitFor(() => seen.approvals.length === 1)
    const req = seen.approvals[0]?.request
    expect(req?.id).toBe(requestId)
    expect(req?.title).toBe('Print clip.gcode on Bay 2')
    expect(req?.actions.map((a) => a.action)).toEqual(['printer.upload', 'printer.start'])
    expect(req?.origin).toBe('phone')
    expect(seen.jobs.map((j) => j.state)).toEqual(['awaiting_approval'])
    expect((await w.sim.status('bay-2')).state).toBe('idle')

    const view = seen.approvals[0]
    if (!view) throw new Error('no approval')
    await conn.approve(view)
    await waitFor(() => seen.jobs.some((j) => j.state === 'started' || j.state === 'failed'))
    expect(seen.jobs.map((j) => j.state)).toEqual(['awaiting_approval', 'uploading', 'starting', 'started'])
    expect((await w.sim.status('bay-2')).state).not.toBe('idle')
    expect(w.host.audit()).toMatchObject([{ requestId, decision: 'approve', deviceName: 'Pocket' }])
  })

  it('a denial leaves the printer alone', async () => {
    const w = await world()
    const conn = await connected(w, w.phone('Pocket'))
    const seen = collect(conn)
    const slice = await conn.uploadSlice({ name: 'clip.gcode', kind: 'gcode', data: GCODE })
    await conn.send({ sliceId: slice.sliceId, target: { printerIds: ['bay-2'] }, start: true })
    await waitFor(() => seen.approvals.length === 1)
    const v = seen.approvals[0]
    if (!v) throw new Error('no approval')
    await conn.deny(v)
    await waitFor(() => seen.jobs.some((j) => j.state === 'denied'))
    expect((await w.sim.status('bay-2')).state).toBe('idle')
    await expect(conn.approve(v)).rejects.toThrow(/already decided/)
  })

  it('the host can approve on its own card instead', async () => {
    const w = await world()
    const conn = await connected(w, w.phone('Pocket'))
    const seen = collect(conn)
    const onHost: ApprovalView[] = []
    w.host.jobApprovals.onRequest((v) => onHost.push(v))
    const slice = await conn.slice({ source: { kind: 'library', id: 'lib-1' }, where: 'host', options: { material: 'petg', easy: { detail: 40, strength: 20, speed: 'standard', supports: 'auto', brim: true } } })
    expect(slice.timeS).toBe(3720)
    expect(slice.sizeBytes).toBe(new TextEncoder().encode('; sliced library petg 40\nG28\n').length)
    await conn.send({ sliceId: slice.sliceId, target: { printerIds: ['bay-2'] }, start: false })
    await waitFor(() => onHost.length === 1)
    expect(onHost[0]?.requestedBy).toBe('Pocket')
    await w.host.jobApprovals.decide(onHost[0]?.request.id ?? '', { kind: 'approve' })
    await waitFor(() => seen.jobs.some((j) => j.state === 'queued'))
    expect((await w.sim.status('bay-2')).state).toBe('idle')
  })

  it('a phone without the approve right cannot approve, even its own job', async () => {
    const w = await world()
    const conn = await connected(w, w.phone('Pocket'))
    const seen = collect(conn)
    const [device] = await w.host.devices()
    await w.host.setRights(device?.pairingId ?? '', { request: true, approve: false, introduce: false })
    const slice = await conn.uploadSlice({ name: 'clip.gcode', kind: 'gcode', data: GCODE })
    await conn.send({ sliceId: slice.sliceId, target: { printerIds: ['bay-2'] }, start: true })
    const [view] = await conn.approvals()
    if (!view) throw new Error('own request should be listed')
    await expect(conn.approve(view)).rejects.toThrow(/may not approve/)
    expect(seen.approvals).toEqual([])
  })

  it('a decision signed for another request is refused', async () => {
    const w = await world()
    const phone = w.phone('Pocket')
    const conn = await connected(w, phone)
    const seen = collect(conn)
    const slice = await conn.uploadSlice({ name: 'clip.gcode', kind: 'gcode', data: GCODE })
    await conn.send({ sliceId: slice.sliceId, target: { printerIds: ['bay-2'] }, start: true })
    await waitFor(() => seen.approvals.length === 1)
    const real = seen.approvals[0]?.request
    if (!real) throw new Error('no approval')
    // The phone was shown a different request (for example a tampered title) and signed that one.
    const shown: ApprovalRequest = { ...real, title: 'Send a test file' }
    const forged = { request: shown, source: 'pair' as const }
    await expect(conn.approve(forged)).rejects.toThrow(/does not match/)
    expect((await w.sim.status('bay-2')).state).toBe('idle')
  })

  it('an approval after the request expired starts nothing', async () => {
    const w = await world()
    const conn = await connected(w, w.phone('Pocket'))
    const seen = collect(conn)
    const slice = await conn.uploadSlice({ name: 'clip.gcode', kind: 'gcode', data: GCODE })
    await conn.send({ sliceId: slice.sliceId, target: { printerIds: ['bay-2'] }, start: true })
    await waitFor(() => seen.approvals.length === 1)
    w.env.advance(6 * 60 * 1000)
    const v = seen.approvals[0]
    if (!v) throw new Error('no approval')
    await conn.approve(v)
    await waitFor(() => seen.jobs.some((j) => j.state === 'expired'))
    expect((await w.sim.status('bay-2')).state).toBe('idle')
  })

  it('a fleet target asks once and covers each printer', async () => {
    const w = await world()
    const conn = await connected(w, w.phone('Pocket'))
    const seen = collect(conn)
    const slice = await conn.uploadSlice({ name: 'clip.gcode', kind: 'gcode', data: GCODE })
    await conn.send({ sliceId: slice.sliceId, target: { fleetId: 'workshop' }, start: false })
    await waitFor(() => seen.approvals.length === 1)
    const req = seen.approvals[0]?.request
    expect(req?.actions.map((a) => a.target)).toEqual(['bay-1', 'bay-2', 'bay-3'])
    expect(req?.permission).toBe('queue')
  })

  it('refuses an upload whose bytes do not match the hash', async () => {
    const w = await world()
    const phone = w.phone('Pocket')
    await connected(w, phone)
    const rpc = await rawRpc(w, phone)
    const begin = await rpc.call('upload.begin', { name: 'clip.gcode', kind: 'gcode', size: GCODE.length, sha256: '0'.repeat(64) })
    await rpc.call('upload.chunk', { uploadId: begin.uploadId, offset: 0, data: toB64url(GCODE) })
    await expect(rpc.call('upload.finish', { uploadId: begin.uploadId })).rejects.toThrow(/intact/)
    await expect(rpc.call('upload.begin', { name: 'big.gcode', kind: 'gcode', size: 1024 ** 3, sha256: '0'.repeat(64) })).rejects.toThrow(/too large/)
  })

  it('a decision signed by another device key is refused', async () => {
    const w = await world()
    const phone = w.phone('Pocket')
    const conn = await connected(w, phone)
    const seen = collect(conn)
    const slice = await conn.uploadSlice({ name: 'clip.gcode', kind: 'gcode', data: GCODE })
    await conn.send({ sliceId: slice.sliceId, target: { printerIds: ['bay-2'] }, start: true })
    await waitFor(() => seen.approvals.length === 1)
    const real = seen.approvals[0]?.request
    if (!real) throw new Error('no approval')
    const rpc = await rawRpc(w, phone)
    const other = createIdentity(w.env, 'Other', 'android')
    await expect(rpc.call('approvals.decide', signDecision(other, real, 'approve', w.env.now()))).rejects.toThrow(/does not match/)
    expect((await w.sim.status('bay-2')).state).toBe('idle')
  })

  it('rejects malformed parameters before any handler runs', async () => {
    const w = await world()
    const phone = w.phone('Pocket')
    await connected(w, phone)
    const rpc = await rawRpc(w, phone)
    const call = rpc.call as (m: string, p: unknown) => Promise<unknown>
    await expect(call('jobs.send', { sliceId: 'x', target: { printerIds: [] }, start: true })).rejects.toThrow(/Invalid parameters/)
    await expect(call('printers.status', { printerId: 'a'.repeat(5000) })).rejects.toThrow(/Invalid parameters/)
    await expect(call('__proto__', {})).rejects.toThrow(/Unknown method/)
  })

  it('refuses unknown printers and slices from another phone', async () => {
    const w = await world()
    const a = await connected(w, w.phone('A'))
    const b = await connected(w, w.phone('B'))
    const slice = await a.uploadSlice({ name: 'clip.gcode', kind: 'gcode', data: GCODE })
    await expect(a.send({ sliceId: slice.sliceId, target: { printerIds: ['bay-99'] }, start: true })).rejects.toThrow(/Unknown printer/)
    await expect(b.send({ sliceId: slice.sliceId, target: { printerIds: ['bay-2'] }, start: true })).rejects.toThrow(/Unknown slice/)
  })

  it('an approver phone can decide approvals raised by mimir on the host', async () => {
    const w = await world()
    const conn = await connected(w, w.phone('Pocket'))
    const seen = collect(conn)
    const req: ApprovalRequest = {
      id: 'pilot-1',
      sessionId: 's1',
      tool: 'start_print',
      permission: 'start',
      title: 'Start Bracket on Bay 2',
      lines: ['PETG, 0.2 mm'],
      paramsHash: '0'.repeat(64),
      actions: [],
      expiresAt: new Date(w.env.now() + 60_000).toISOString(),
    }
    w.feed.push(req)
    await waitFor(() => seen.approvals.length === 1)
    expect(seen.approvals[0]?.source).toBe('pilot')
    const v = seen.approvals[0]
    if (!v) throw new Error('no approval')
    await conn.approve(v)
    expect(w.feed.decisions).toMatchObject([{ requestId: 'pilot-1', decision: { kind: 'approve' }, by: { name: 'Pocket' } }])
  })
})
