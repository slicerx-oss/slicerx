// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Unit tests need nothing. The bridge tests run the real target/debug/sx-link against the mock printers.
import assert from 'node:assert/strict'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { after, before, test } from 'node:test'
import { connectLink, type LinkHost } from '@slicerx/link-client'
import { startMocks, type RunningMocks } from '@slicerx/mock-printers'
import { SetupError, createPrinterSetup, foundPrinter, parseAddress, resolveFamily, resolveModel } from './index.ts'

// Runs only when SX_LINK_BIN names a built sx-link (cargo build -p sx-link), with a throwaway state
// directory and file secrets, so a test never touches the real hub state or the keychain.
const bin = process.env['SX_LINK_BIN'] ?? ''
const skip = bin && existsSync(bin) ? false : 'set SX_LINK_BIN to a built sx-link to run'
const dir = skip ? '' : mkdtempSync(join(tmpdir(), 'sx-link-test-'))

test('addresses, families and models resolve', () => {
  assert.deepEqual(parseAddress('192.168.1.5'), { host: '192.168.1.5' })
  assert.deepEqual(parseAddress('http://printer.local:7125/'), { host: 'printer.local', port: 7125 })
  assert.deepEqual(parseAddress(' [fe80::1%en0]:80 '), { host: 'fe80::1%en0', port: 80 })
  assert.throws(() => parseAddress(''), SetupError)
  assert.throws(() => parseAddress('host:99999'), SetupError)
  assert.equal(resolveFamily('Bambu'), 'bambu-lan')
  assert.equal(resolveFamily('moonraker'), 'moonraker')
  assert.equal(resolveFamily('nope'), undefined)
  assert.equal(resolveModel('bambu-a1')?.name, 'A1')
  assert.equal(resolveModel('BBL/Bambu Lab A1 0.4 nozzle'), undefined)
  assert.equal(resolveModel('Some Custom Printer'), undefined)
})

test('a scan result keeps what the printer announced, and drops the usual port', async () => {
  // A Bambu Lab H2D's SSDP answer, as sx-link reports it.
  const h2d = foundPrinter({ plugin: 'bambu-lan', host: '192.168.1.52', port: 8883, name: 'Workshop H2D', model: 'H2D', serial: '0948AA000000001', firmware: '01.03.00.00', lanOnly: false })
  assert.deepEqual(h2d, { id: '0948AA000000001', name: 'Workshop H2D', family: 'bambu-lan', address: '192.168.1.52', model: 'H2D', serial: '0948AA000000001', firmware: '01.03.00.00', lanOnly: false })
  assert.equal(foundPrinter({ plugin: 'moonraker', host: '192.168.1.9', port: 7126 }).address, '192.168.1.9:7126')
  // A Moonraker announcement's uuid keeps the printer the same one when its address changes.
  assert.equal(foundPrinter({ plugin: 'moonraker', host: '192.168.1.9', port: 7125, uid: 'f0e1d2c3' }).id, 'f0e1d2c3')
  // A bridge without `probe` answers an empty list.
  const setup = createPrinterSetup({} as never)
  assert.deepEqual(await setup.probe('192.168.1.52'), [])
  const probing = createPrinterSetup({ probe: async (host: string) => [{ plugin: 'bambu-lan', host, port: 8883, model: 'H2D', serial: 'S1' }] } as never)
  assert.deepEqual((await probing.probe(' 192.168.1.52 ')).map((p) => [p.address, p.model]), [['192.168.1.52', 'H2D']])
})

let proc: ChildProcessByStdio<null, Readable, Readable>
let mocks: RunningMocks
let host: LinkHost

before(async () => {
  if (skip) return
  mocks = await startMocks({ only: ['moonraker'], state: 'idle' })
  proc = spawn(bin, ['--port', '0', '--state-dir', dir, '--secrets', 'file', '--no-mdns'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  const [url, code] = await new Promise<[string, string]>((resolve, reject) => {
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      const u = /ws:\/\/127\.0\.0\.1:\d+/.exec(out)
      const c = /pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)
      if (u && c) resolve([u[0], c[1] ?? ''])
    })
    proc.once('exit', () => reject(new Error('sx-link exited early')))
  })
  host = await connectLink({ url, code })
})

after(async () => {
  host?.close()
  proc?.kill()
  if (dir) rmSync(dir, { recursive: true, force: true })
  await mocks?.stop()
})

const moonAddress = () => `127.0.0.1:${mocks.ports.moonraker ?? 0}`

test('discover maps suggestions to the setup shape and can be canceled', { skip }, async () => {
  const setup = createPrinterSetup(host)
  const found = await setup.discover({ timeoutMs: 300 })
  for (const p of found) assert.ok(p.id && p.name && p.family)
  const ctl = new AbortController()
  const scan = setup.discover({ timeoutMs: 5000, signal: ctl.signal })
  ctl.abort()
  await assert.rejects(scan, { name: 'AbortError' })
})

test('testConnection reports success and failure and leaves nothing behind', { skip }, async () => {
  const setup = createPrinterSetup(host)
  const ok = await setup.testConnection({ family: 'moonraker', address: moonAddress() })
  assert.equal(ok.ok, true)
  assert.equal(ok.state, 'idle')
  const bad = await setup.testConnection({ family: 'moonraker', address: '127.0.0.1:1' })
  assert.equal(bad.ok, false)
  assert.equal(bad.cause, 'unreachable')
  assert.equal(bad.steps[0]?.ok, false)
const off = await setup.testConnection({ family: 'moonraker', address: '8.8.8.8' })
  assert.equal(off.cause, 'bad_request')
  assert.equal((await host.list()).length, 0)
})

test('addPrinter registers with the catalog model from the bridge', { skip }, async () => {
  const setup = createPrinterSetup(host)
  const { printerId } = await setup.addPrinter({
    profileId: 'voron-2.4-350',
    nozzleMm: 0.4,
    connection: { family: 'moonraker', address: moonAddress() },
  })
  assert.equal(printerId, 'voron-2-4-350')
  const info = (await host.list()).find((p) => p.id === printerId)
  assert.equal(info?.model, 'Voron 2.4 350')
  assert.equal(info?.vendor, 'Voron Design')
  assert.equal((await host.status(printerId)).state, 'idle')
  // A second printer of the same model gets its own id.
  const second = await setup.addPrinter({ profileId: 'voron-2.4-350', nozzleMm: 0.6, connection: { family: 'moonraker', address: moonAddress() } })
  assert.equal(second.printerId, 'voron-2-4-350-2')
})

test('addPrinter refuses bad input and cleans up after a failure', { skip }, async () => {
  const setup = createPrinterSetup(host)
  await assert.rejects(setup.addPrinter({ profileId: 'bambu-a1', nozzleMm: 0.4, connection: { family: 'bambu-lan', address: '192.168.1.9', credential: '12345678' } }), { code: 'bad_request' })
  await assert.rejects(setup.addPrinter({ profileId: 'bambu-a1', nozzleMm: 5 }), { code: 'bad_request' })
  await assert.rejects(setup.addPrinter({ profileId: 'bambu-a1', nozzleMm: 0.4, connection: { family: 'nope', address: 'x' } }), { code: 'bad_request' })
  // A public address is refused by the bridge; the stored secret is removed again.
  await assert.rejects(setup.addPrinter({ profileId: 'x', nozzleMm: 0.4, connection: { family: 'moonraker', address: '8.8.8.8' } }))
})

test('a printer with no connection is kept for the host to save', { skip }, async () => {
  const setup = createPrinterSetup(host)
  const { printerId } = await setup.addPrinter({ profileId: 'snapmaker-j1', nozzleMm: 0.4 })
  assert.deepEqual(setup.localPrinters().map((p) => [p.printerId, p.modelId, p.nozzleMm]), [[printerId, 'snapmaker-j1', 0.4]])
})

// The bridge writes secrets to the real OS keychain, so the credential path runs against a fake link.
test('credentials go to the secret store under a per-printer name and are removed when adding fails', async () => {
  const secrets = new Map<string, string>()
  const calls: unknown[] = []
  let fail = false
  const link = {
    discover: async () => [],
    setSecret: async (n: string, v: string) => void secrets.set(n, v),
    deleteSecret: async (n: string) => void secrets.delete(n),
    removePrinter: async () => undefined,
    authorizePrinter: async () => ({ stored: true }),
    testPrinter: async (config: unknown) => {
      calls.push(config)
      return { ok: true, steps: [] }
    },
    addPrinter: async (config: unknown, info: unknown) => {
      calls.push([config, info])
      if (fail) throw new Error('refused')
      return {} as never
    },
  } as unknown as Parameters<typeof createPrinterSetup>[0]
  const setup = createPrinterSetup(link)
  const bambu = { family: 'bambu', address: '192.168.1.9', serial: '01S00C000000000', credential: '12345678' }
  const { printerId } = await setup.addPrinter({ profileId: 'bambu-a1', nozzleMm: 0.4, connection: bambu })
  assert.equal(secrets.get(`printer-${printerId}`), '12345678')
  const [config, info] = calls[0] as [Record<string, unknown>, Record<string, unknown>]
  assert.equal(config.credentialRef, `printer-${printerId}`)
  assert.equal(config.plugin, 'bambu-lan')
  assert.equal(JSON.stringify(config).includes('12345678'), false, 'the access code is only in the secret store')
  assert.deepEqual(info, { vendor: 'Bambu Lab', model: 'A1', nozzleCount: 1, filamentSystem: 'ams' })

  fail = true
  await assert.rejects(setup.addPrinter({ profileId: 'bambu-a1', nozzleMm: 0.4, connection: bambu }), /refused/)
  assert.equal(secrets.size, 1, 'the failed add left no secret behind')

  await setup.testConnection(bambu)
  assert.equal(secrets.size, 1, 'a test uses a temporary secret and removes it')

  // An address alone is enough: the printer's certificate names its serial number.
  fail = false
  await setup.addPrinter({ profileId: 'bambu-a1', nozzleMm: 0.4, connection: { family: 'bambu', address: '192.168.1.10', credential: '12345678' } })
  assert.equal((calls.at(-1) as [Record<string, unknown>])[0].serial, undefined)
})

test('a code the keychain refuses still saves the printer, and the result says it is kept for the session', async () => {
  const link = {
    discover: async () => [],
    // The bridge's answer when Windows Credential Manager refuses the write.
    setSecret: async () => ({ kept: 'session' as const }),
    deleteSecret: async () => undefined,
    removePrinter: async () => undefined,
    authorizePrinter: async () => ({ stored: true }),
    testPrinter: async () => ({ ok: true, steps: [] }),
    addPrinter: async () => ({}) as never,
  } as unknown as Parameters<typeof createPrinterSetup>[0]
  const setup = createPrinterSetup(link)
  const bambu = { family: 'bambu', address: '192.168.1.231', serial: '01P00A000000000', credential: '12345678' }
  const added = await setup.addPrinter({ profileId: 'bambu-p1s', nozzleMm: 0.4, connection: bambu })
  assert.equal(added.credentialKept, 'session')
  const plain = createPrinterSetup({ ...link, setSecret: async () => ({ kept: 'stored' as const }) })
  assert.equal((await plain.addPrinter({ profileId: 'bambu-p1s', nozzleMm: 0.4, connection: bambu })).credentialKept, undefined)
})
