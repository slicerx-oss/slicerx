// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A printer's live view read the way a client reads it: slicerx_printer_status through the real
// sx-link binary and the Elegoo mock printer. Skipped when sx-link is not built.
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectLink } from '@slicerx/link-client'
import { startMocks, type RunningMocks } from '@slicerx/mock-printers'
import { connect, data } from './helpers'

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
    mocks = await startMocks({ only: ['elegoo'], state: 'idle' })
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
})
