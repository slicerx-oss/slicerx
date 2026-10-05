// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs the real sx-link binary (built by `cargo test -p sx-link`) against the mock printers.
// The binary refuses every approval token until sx-permit is wired in, so side effects must
// fail with approval_invalid, which is what these tests check.
import assert from 'node:assert/strict'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { after, before, test } from 'node:test'
import type { PrinterEvent } from '@slicerx/contracts'
import { startMocks, type RunningMocks } from '@slicerx/mock-printers'
import { connectLink, LinkError, type LinkHost } from './index.ts'

// Runs only when SX_LINK_BIN names a built sx-link (cargo build -p sx-link), with a throwaway state
// directory and file secrets, so a test never touches the real hub state or the keychain.
const bin = process.env['SX_LINK_BIN'] ?? ''
const skip = bin && existsSync(bin) ? false : 'set SX_LINK_BIN to a built sx-link to run'
const dir = skip ? '' : mkdtempSync(join(tmpdir(), 'sx-link-test-'))

let proc: ChildProcessByStdio<null, Readable, Readable>
let mocks: RunningMocks
let url = ''
let code = ''

before(async () => {
  if (skip) return
  mocks = await startMocks({ only: ['moonraker', 'spoolman'], state: 'idle' })
  proc = spawn(bin, ['--port', '0', '--state-dir', dir, '--secrets', 'file', '--no-mdns'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  await new Promise<void>((resolve, reject) => {
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      const u = /ws:\/\/127\.0\.0\.1:\d+/.exec(out)
      const c = /pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)
      if (u && c) { url = u[0]; code = c[1] ?? ''; resolve() }
    })
    proc.once('exit', () => reject(new Error('sx-link exited early')))
  })
})

after(async () => {
  proc?.kill()
  if (dir) rmSync(dir, { recursive: true, force: true })
  await mocks?.stop()
})

const token = { requestId: 'r', token: 'forged', expiresAt: '' }

test('a wrong pairing code is refused', { skip }, async () => {
  await assert.rejects(connectLink({ url, code: 'AAAA-AAAA' }), (e: unknown) => e instanceof LinkError && e.code === 'unauthorized')
})

test('pairs, lists plugins, reads a printer and streams events', { skip }, async () => {
  const host: LinkHost = await connectLink({ url, code })
  try {
    // Connectors not yet tested on real printers stay hidden until the person turns them on.
    assert.equal((await host.plugins()).length, 6)
    await host.settings.set({ experimentalConnectors: true })
    assert.equal((await host.plugins()).length, 10)
    await host.settings.set({ experimentalConnectors: false })
    const info = await host.addPrinter({ id: 'bay-4', name: 'Bay 4', plugin: 'moonraker', host: '127.0.0.1', port: mocks.ports.moonraker ?? 0, pollMs: 50 }, { model: 'Voron 2.4 350' })
    assert.equal(info.model, 'Voron 2.4 350')
    assert.equal((await host.list()).length, 1)
    assert.equal((await host.status('bay-4')).state, 'idle')

    const seen: PrinterEvent[] = []
    const off = host.subscribe('bay-4', (e) => seen.push(e))
    for (let i = 0; i < 40 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 25))
    off()
    assert.equal(seen[0]?.type, 'status')

    const snap = await host.snapshot('bay-4')
    assert.ok(snap)
    assert.equal(snap.type, 'image/jpeg')
    assert.deepEqual([...new Uint8Array(await snap.arrayBuffer()).subarray(0, 2)], [0xff, 0xd8])
  } finally {
    host.close()
  }
})

test('side effects need a valid approval token', { skip }, async () => {
  const host = await connectLink({ url, code })
  try {
    await host.addPrinter({ id: 'bay-4', name: 'Bay 4', plugin: 'moonraker', host: '127.0.0.1', port: mocks.ports.moonraker ?? 0 })
    const data = new TextEncoder().encode('G28\n').buffer as ArrayBuffer
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('')
    await assert.rejects(host.upload('bay-4', { name: 'x.gcode', kind: 'gcode', data, sha256: sha }, token), (e: unknown) => e instanceof LinkError && e.code === 'approval_invalid')
    await assert.rejects(host.pause('bay-4', token), (e: unknown) => e instanceof LinkError && e.code === 'approval_invalid')
    await assert.rejects(host.addPrinter({ id: 'x', name: 'x', plugin: 'moonraker', host: '8.8.8.8' }), (e: unknown) => e instanceof LinkError && e.code === 'bad_request')
  } finally {
    host.close()
  }
})

test('service tools and write only secrets', { skip }, async () => {
  const host = await connectLink({ url, code })
  try {
    await host.configureService('spoolman', `http://127.0.0.1:${mocks.ports.spoolman ?? 0}`)
    const spools = (await host.callTool('spoolman', 'spoolman.list_spools', { material: 'TPU' })) as { id: number }[]
    assert.equal(spools.length, 1)
    assert.deepEqual(
      (await host.listServices()).map((s) => s.pluginId),
      ['spoolman'],
    )
    assert.equal(await host.removeService('spoolman'), true)
    assert.deepEqual(await host.listServices(), [])
    assert.equal(typeof host.setSecret, 'function')
    assert.equal('getSecret' in host, false)
  } finally {
    host.close()
  }
})

test('fleets group printers and survive removing a printer', { skip }, async () => {
  const host = await connectLink({ url, code })
  try {
    await host.addPrinter({ id: 'bay-1', name: 'Bay 1', plugin: 'moonraker', host: '127.0.0.1', port: mocks.ports.moonraker ?? 0 })
    await host.addPrinter({ id: 'bay-2', name: 'Bay 2', plugin: 'moonraker', host: '127.0.0.1', port: mocks.ports.moonraker ?? 0 })
    const bench = await host.createFleet('Bench', { color: 'cyan', printerIds: ['bay-1'] })
    assert.deepEqual((await host.addToFleet(bench.id, 'bay-2')).printerIds, ['bay-1', 'bay-2'])
    assert.equal((await host.renameFleet(bench.id, 'Back bench')).name, 'Back bench')
    assert.equal((await host.updateFleet(bench.id, { color: null })).color, undefined)
    await assert.rejects(host.createFleet('back BENCH'), (e: unknown) => e instanceof LinkError && e.code === 'protocol')
    await host.removePrinter('bay-1')
    assert.deepEqual((await host.fleets())[0]?.printerIds, ['bay-2'])
    const printers = (await host.list()).length
    await host.deleteFleet(bench.id)
    assert.equal((await host.list()).length, printers, 'deleting a fleet keeps its printers')
    assert.ok((await host.list()).some((p) => p.id === 'bay-2'))
  } finally {
    host.close()
  }
})

test('the approval broker mints tokens that are bound to the exact action and parameters', { skip }, async () => {
  const host = await connectLink({ url, code })
  try {
    await host.addPrinter({ id: 'bay-4', name: 'Bay 4', plugin: 'moonraker', host: '127.0.0.1', port: mocks.ports.moonraker ?? 0 })
    const zeros = '0'.repeat(64)
    await host.approvals.register({
      id: 'req-a', sessionId: 's', tool: 'moonraker.pause', permission: 'start', title: 'Pause Bay 4?', lines: [], printerId: 'bay-4',
      paramsHash: zeros, actions: [{ action: 'printer.pause', target: 'bay-4', paramsHash: zeros }], expiresAt: '2099-01-01T00:00:00.000Z',
    })
    const token = await host.approvals.grant('req-a')
    assert.equal(typeof token.token, 'string')
    // The hash the connector computes for a pause is not the zero hash, so the token is refused.
    await assert.rejects(host.pause('bay-4', token), (e: unknown) => e instanceof LinkError && e.code === 'approval_invalid' && /mismatch/.test(e.message))

    await host.approvals.register({
      id: 'req-b', sessionId: 's', tool: 'moonraker.pause', permission: 'start', title: 'Pause Bay 4?', lines: [],
      paramsHash: zeros, actions: [{ action: 'printer.pause', target: 'bay-4', paramsHash: zeros }], expiresAt: '2099-01-01T00:00:00.000Z',
    })
    await host.approvals.deny('req-b')
    await assert.rejects(host.approvals.grant('req-b'), (e: unknown) => e instanceof LinkError && e.code === 'bad_request')
  } finally {
    host.close()
  }
})

test('a bridge without an inbox says so', { skip }, async () => {
  const host = await connectLink({ url, code })
  try {
    await assert.rejects(host.inbox.list(), (e: unknown) => e instanceof LinkError && e.code === 'not_supported')
    assert.equal(typeof host.inbox.onDelivery(() => undefined), 'function')
  } finally {
    host.close()
  }
})

test('phone frames pass through the LAN listener', { skip }, async () => {
  const host = await connectLink({ url, code })
  try {
    const { port } = await host.pair.listen(true, 0)
    assert.ok(port && port > 0)
    const frames: [string, string][] = []
    const closed: string[] = []
    host.pair.onFrame((c, f) => frames.push([c, f]))
    host.pair.onClosed((c) => closed.push(c))
    const phone = new WebSocket(`ws://127.0.0.1:${port}/pair`)
    const fromApp: string[] = []
    phone.addEventListener('message', (m) => fromApp.push(String(m.data)))
    await new Promise<void>((r, j) => { phone.addEventListener('open', () => r()); phone.addEventListener('error', () => j(new Error('phone could not connect'))) })
    phone.send('offer')
    for (let i = 0; i < 40 && frames.length === 0; i++) await new Promise((r) => setTimeout(r, 25))
    assert.equal(frames[0]?.[1], 'offer')
    await host.pair.send(frames[0]?.[0] ?? '', 'answer')
    for (let i = 0; i < 40 && fromApp.length === 0; i++) await new Promise((r) => setTimeout(r, 25))
    assert.deepEqual(fromApp, ['answer'])
    phone.close()
    for (let i = 0; i < 40 && closed.length === 0; i++) await new Promise((r) => setTimeout(r, 25))
    assert.equal(closed[0], frames[0]?.[0])
    await host.pair.listen(false)
  } finally {
    host.close()
  }
})

test('discover returns well formed suggestions and only local addresses', { skip }, async () => {
  const host = await connectLink({ url, code })
  try {
    const found = await host.discover(300)
    assert.ok(Array.isArray(found))
    for (const p of found) {
      assert.equal(typeof p.plugin, 'string')
      assert.match(p.host, /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|[0-9a-f:]+$|[a-z0-9-]+(\.local|\.lan)?$)/i)
    }
  } finally {
    host.close()
  }
})
