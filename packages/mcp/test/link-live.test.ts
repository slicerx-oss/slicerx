// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer's live view read the way a client reads it: slicerx_printer_status through the real
// sx-link binary and the Elegoo, Snapmaker 2.0 and Bambu Lab mock printers. Skipped when sx-link is not built.
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectLink } from '@slicerx/link-client'
import { MOCK_ACCESS_CODE, MOCK_SERIAL, startMocks, type RunningMocks } from '@slicerx/mock-printers'
import { connect, data, text } from './helpers'

// Runs only when SX_LINK_BIN names a built sx-link, with a throwaway state directory and file
// secrets, so a test never touches the real hub state or the keychain.
const bin = process.env['SX_LINK_BIN'] ?? ''
const dir = bin && existsSync(bin) ? mkdtempSync(join(tmpdir(), 'sx-link-live-')) : ''

describe.skipIf(!bin || !existsSync(bin))('live view through sx-link', () => {
  let proc: ChildProcessByStdio<null, Readable, Readable>
  let mocks: RunningMocks
  let url = ''
  let code = ''

  beforeAll(async () => {
    mocks = await startMocks({ only: ['elegoo', 'snapmaker-luban', 'bambu'], state: 'idle' })
    proc = spawn(bin, ['--port', '0', '--state-dir', dir, '--secrets', 'file', '--no-mdns', '--loopback'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    await new Promise<void>((done, fail) => {
      proc.stdout.on('data', (d: Buffer) => {
        out += d.toString()
        const u = /ws:\/\/127\.0\.0\.1:\d+/.exec(out)
        const c = /pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)
        if (u && c) {
          url = u[0]
          code = c[1] ?? ''
          done()
        }
      })
      proc.once('exit', () => fail(new Error('sx-link exited early')))
    })
    const setup = await connectLink({ url, code })
    await setup.addPrinter({ id: 'bay-7', name: 'Bay 7', plugin: 'elegoo', host: '127.0.0.1', port: mocks.ports.elegoo ?? 0 }, { model: 'Centauri Carbon' })
    // The Snapmaker connector is experimental; pairing waits for the mock's confirmation (two status polls).
    await setup.settings.set({ experimentalConnectors: true })
    await setup.addPrinter({ id: 'bay-8', name: 'Bay 8', plugin: 'snapmaker', host: '127.0.0.1', port: mocks.ports['snapmaker-luban'] ?? 0, protocol: 'luban', credentialRef: 'printer/bay-8/token', pollMs: 100 }, { model: 'A350' })
    await setup.authorizePrinter('bay-8', 30)
    await setup.setSecret('bay-9-code', MOCK_ACCESS_CODE)
    await setup.addPrinter({ id: 'bay-9', name: 'Bay 9', plugin: 'bambu-lan', host: '127.0.0.1', port: mocks.ports['bambu'] ?? 0, serial: MOCK_SERIAL, credentialRef: 'bay-9-code', ftpPort: mocks.ports['bambu-ftp'] ?? 0, cameraPort: mocks.ports['bambu-camera'] ?? 0, pollMs: 200 }, { vendor: 'Bambu Lab', model: 'P1S' })
    setup.close()
  }, 30_000)

  afterAll(async () => {
    proc?.kill()
    if (dir) rmSync(dir, { recursive: true, force: true })
    await mocks?.stop()
  })

  it("reads an Elegoo printer's speed and light, and the height printing now while it prints", async () => {
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${mocks.control}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const h = await connect({ printers: 'link', linkUrl: url, linkCode: code })
    type Status = { output: { state: string; live?: { speedPercent?: number; light?: boolean; layerZMm?: number } } }
    const read = async () => data<Status>(await h.call('slicerx_printer_status', { printerId: 'bay-7' })).output
    await expect.poll(async () => (await read()).live?.light, { timeout: 10_000 }).toBe(true)
    expect((await read()).live?.speedPercent).toBe(100)
    expect((await read()).live?.layerZMm).toBeUndefined()
    await post('/set', { mock: 'elegoo', state: 'printing' })
    await expect.poll(async () => (await read()).state, { timeout: 10_000 }).toBe('printing')
    expect(typeof (await read()).live?.layerZMm).toBe('number')
    await post('/set', { mock: 'elegoo', state: 'idle' })
  })

  it("reads a Snapmaker 2.0 machine's height printing now while it prints", async () => {
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${mocks.control}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const h = await connect({ printers: 'link', linkUrl: url, linkCode: code })
    type Status = { output: { state: string; live?: { layerZMm?: number } } }
    const read = async () => data<Status>(await h.call('slicerx_printer_status', { printerId: 'bay-8' })).output
    await expect.poll(async () => (await read()).state, { timeout: 10_000 }).toBe('idle')
    expect((await read()).live).toBeUndefined()
    await post('/set', { mock: 'snapmaker-luban', state: 'printing' })
    await expect.poll(async () => (await read()).state, { timeout: 10_000 }).toBe('printing')
    expect(typeof (await read()).live?.layerZMm).toBe('number')
    await post('/set', { mock: 'snapmaker-luban', state: 'idle' })
  })

  it('says the camera guard cannot watch the Snapmaker 2.0, which has no camera, in printer_status and printer_list', async () => {
    const h = await connect({ printers: 'link', linkUrl: url, linkCode: code })
    type Status = { output: { cameraAvailable: boolean; cameraGuard?: string } }
    const res = await h.call('slicerx_printer_status', { printerId: 'bay-8' })
    const st = data<Status>(res)
    expect(st.output.cameraAvailable).toBe(false)
    expect(st.output.cameraGuard).toBe('no_camera')
    expect(text(res)).toContain("the camera guard can't watch it")
    type Row = { id: string; cameraGuard?: string }
    const rows = data<{ output: Row[] }>(await h.call('slicerx_printer_list', {})).output
    expect(rows.find((r) => r.id === 'bay-8')?.cameraGuard).toBe('no_camera')
    // Each printer that answers carries the field, read back the same way from its own status.
    for (const id of ['bay-7', 'bay-9']) {
      const own = data<Status>(await h.call('slicerx_printer_status', { printerId: id })).output
      expect(rows.find((r) => r.id === id)?.cameraGuard).toBe(own.cameraAvailable ? 'can_watch' : 'no_camera')
    }
  })

  it("reads the exact grams left in a Bambu Lab printer's AMS slots", async () => {
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${mocks.control}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    await post('/bambu', { grams: { 0: 812, 2: 95 } })
    const h = await connect({ printers: 'link', linkUrl: url, linkCode: code })
    type Status = { output: { slots?: { id: string; remainingG?: number; remainingPct?: number }[] } }
    const read = async () => data<Status>(await h.call('slicerx_printer_status', { printerId: 'bay-9' })).output.slots ?? []
    await expect.poll(async () => (await read()).find((s) => s.id === 'A1')?.remainingG, { timeout: 15_000 }).toBe(812)
    const slots = await read()
    expect(slots.find((s) => s.id === 'A3')?.remainingG).toBe(95)
    // A slot without an exact reading keeps only the percentage estimate.
    expect(slots.find((s) => s.id === 'A2')?.remainingG).toBeUndefined()
  })
})
