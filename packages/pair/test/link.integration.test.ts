// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Phone jobs against the real sx-link binary and its sx-permit broker, with the Moonraker mock
// as the printer. Skipped unless target/debug/sx-link is built (cargo build -p sx-link).
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { connectLink, type LinkHost } from '@slicerx/link-client'
import { startMocks, type RunningMocks } from '@slicerx/mock-printers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HostConnection } from '../src/client'
import { serveLanThroughBridge } from '../src/lan-bridge'
import type { ApprovalView, JobUpdate } from '../src/rpc'
import { flush, pairByLink, world, type World } from './helpers'

// Runs only when SX_LINK_BIN names a built sx-link (cargo build -p sx-link), with a throwaway state
// directory and file secrets, so a test never touches the real hub state or the keychain.
const bin = process.env['SX_LINK_BIN'] ?? ''
const built = bin !== '' && existsSync(bin)
const dir = built ? mkdtempSync(join(tmpdir(), 'sx-link-test-')) : ''

let proc: ChildProcessByStdio<null, Readable, Readable> | undefined
let mocks: RunningMocks | undefined
let url = ''
let code = ''

beforeAll(async () => {
  if (!built) return
  mocks = await startMocks({ only: ['moonraker'], state: 'idle' })
  const p = spawn(bin, ['--port', '0', '--state-dir', dir, '--secrets', 'file', '--no-mdns'], { stdio: ['ignore', 'pipe', 'pipe'] })
  proc = p
  let out = ''
  await new Promise<void>((resolve, reject) => {
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      const u = /ws:\/\/127\.0\.0\.1:\d+/.exec(out)
      const c = /pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)
      if (u && c) {
        url = u[0]
        code = c[1] ?? ''
        resolve()
      }
    })
    p.once('exit', () => reject(new Error('sx-link exited early')))
  })
}, 20_000)

afterAll(async () => {
  proc?.kill()
  if (dir) rmSync(dir, { recursive: true, force: true })
  await mocks?.stop()
})

const GCODE = new TextEncoder().encode('; phone slice\nG28\nG1 X10 Y10 F3000\n')

async function setup(seed: string): Promise<{ w: World; link: LinkHost; conn: HostConnection; jobs: JobUpdate[]; approvals: ApprovalView[] }> {
  const link = await connectLink({ url, code })
  await link.addPrinter({ id: 'bay-4', name: 'Bay 4', plugin: 'moonraker', host: '127.0.0.1', port: mocks?.ports['moonraker'] ?? 0, pollMs: 50 })
  // Each world gets its own seed: the bridge's broker outlives a test and refuses reused request ids.
  const w = await world({ realClock: true, seed, services: { printers: link, approvals: link.approvals } })
  const phone = w.phone('Pocket')
  await pairByLink(w, phone)
  const conn = await phone.client.connect((await phone.client.hosts())[0]?.pairingId ?? '')
  const jobs: JobUpdate[] = []
  const approvals: ApprovalView[] = []
  conn.onJob((u) => jobs.push(u))
  conn.on('approval.request', (v) => approvals.push(v))
  return { w, link, conn, jobs, approvals }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  await flush()
}

describe.skipIf(!built)('phone jobs through sx-link', () => {
  it('uploads and starts on the printer after the phone approves, with a token from the bridge broker', async () => {
    const { link, conn, jobs, approvals } = await setup('approve')
    try {
      const slice = await conn.uploadSlice({ name: 'clip.gcode', kind: 'gcode', data: GCODE })
      await conn.send({ sliceId: slice.sliceId, target: { printerIds: ['bay-4'] }, start: true })
      await until(() => approvals.length === 1)
      expect((await link.status('bay-4')).state).toBe('idle')
      const v = approvals[0]
      if (!v) throw new Error('no approval')
      // Every start that is not the person's own Print click needs the plate confirmed clear on the card.
      await conn.approve(v, { bedClear: true })
      await until(() => jobs.some((j) => j.state === 'started' || j.state === 'failed'))
      expect(jobs.map((j) => j.state), JSON.stringify(jobs)).toEqual(['awaiting_approval', 'uploading', 'starting', 'started'])
      await new Promise((r) => setTimeout(r, 300))
      expect((await link.status('bay-4')).state).not.toBe('idle')
    } finally {
      conn.close()
      link.close()
    }
  }, 20_000)

  it('a denied job never reaches the printer, and the bridge will not mint a token for it', async () => {
    const { link, conn, jobs, approvals } = await setup('deny')
    try {
      const slice = await conn.uploadSlice({ name: 'deny.gcode', kind: 'gcode', data: GCODE })
      await conn.send({ sliceId: slice.sliceId, target: { printerIds: ['bay-4'] }, start: true })
      await until(() => approvals.length === 1)
      const v = approvals[0]
      if (!v) throw new Error('no approval')
      await conn.deny(v)
      await until(() => jobs.some((j) => j.state === 'denied'))
      expect(jobs.map((j) => j.state)).toEqual(['awaiting_approval', 'denied'])
      // The bridge broker refuses to mint a token for the denied request.
      await expect(link.approvals.grant(v.request.id)).rejects.toThrow()
    } finally {
      conn.close()
      link.close()
    }
  }, 20_000)

  it('a phone pairs and prints over the LAN through the sx-link listener, which sees only ciphertext', async () => {
    const link = await connectLink({ url, code })
    await link.addPrinter({ id: 'bay-4', name: 'Bay 4', plugin: 'moonraker', host: '127.0.0.1', port: mocks?.ports['moonraker'] ?? 0, pollMs: 50 })
    const w = await world({ realClock: true, seed: 'lan', services: { printers: link, approvals: link.approvals } })
    const seenByBridge: string[] = []
    link.pair.onFrame((_conn, frame) => seenByBridge.push(frame))
    const lan = await serveLanThroughBridge(w.host, link.pair, 0)
    // The phone in this test runs on the same machine, so it dials loopback; real phones use lan.urls.
    for (const u of lan.urls) expect(u).toMatch(/^ws:\/\/(10|172|192)\.[0-9.]+:\d+\/pair$/)
    const lanUrl = `ws://127.0.0.1:${lan.port ?? 0}/pair`
    w.host.setEndpoints({ lan: [lanUrl] })
    const phone = w.phone('Pocket', { socket: (u) => new WebSocket(u) })
    try {
      const r = await pairByLink(w, phone)
      expect(r.phoneResult.ok).toBe(true)
      const conn = await phone.client.connect((await phone.client.hosts())[0]?.pairingId ?? '')
      expect(conn.via).toBe('lan')
      const jobs: JobUpdate[] = []
      const approvals: ApprovalView[] = []
      conn.onJob((u) => jobs.push(u))
      conn.on('approval.request', (v) => approvals.push(v))
      const slice = await conn.uploadSlice({ name: 'lan.gcode', kind: 'gcode', data: GCODE })
      // Upload only: the first test left the mock printer busy with its print.
      await conn.send({ sliceId: slice.sliceId, target: { printerIds: ['bay-4'] }, start: false })
      await until(() => approvals.length === 1)
      const v = approvals[0]
      if (!v) throw new Error('no approval')
      await conn.approve(v)
      await until(() => jobs.some((j) => j.state === 'queued' || j.state === 'failed'))
      expect(jobs.at(-1)).toMatchObject({ state: 'queued', remoteName: 'lan.gcode' })
      const bridged = seenByBridge.join('\n')
      expect(bridged.length).toBeGreaterThan(0)
      for (const secret of ['Pocket', 'Bay 4', 'lan.gcode', 'G28']) expect(bridged).not.toContain(secret)
      conn.close()
    } finally {
      await lan.stop()
      link.close()
    }
  }, 20_000)
})
