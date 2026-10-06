// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { Host, PrinterHost, PrinterInfo, PrinterStatus } from '@slicerx/contracts'
import { connectionMethod } from '@slicerx/printer-catalog'
import {
  addressOf,
  bedOf,
  BRAND_TILES,
  checkConnection,
  connectionChoices,
  customErrors,
  EMPTY_FORM,
  formView,
  looksPublic,
  nozzleError,
  parseAddress,
  pickBrand,
  pickModel,
  profileIdOf,
  PUBLIC_WARNING,
  searchSetup,
  setFirmware,
  unlocked,
  type PrinterForm,
} from '../src/first-run/printer-form'
import { createHostSetup, type TestStep } from '../src/first-run/setup-host'
import { setBridgeConnector } from '../src/link/bridge'

const bambu = (): PrinterForm => pickModel(pickBrand(EMPTY_FORM, 'bambu-lab'), 'bambu-x1-carbon')

describe('printer form', () => {
  it('lists the brands from the spec in order', () => {
    expect(BRAND_TILES.map((b) => b.name)).toEqual(['Bambu Lab', 'Prusa Research', 'Creality', 'Elegoo', 'Anycubic', 'Snapmaker', 'Voron', 'Ratrig', 'Qidi', 'Sovol', 'Flashforge', 'FLSUN', 'Artillery', 'Anker', 'Custom Klipper', 'Custom Marlin', 'Other'])
  })

  it('fills nozzle, filament system and connection from the model', () => {
    const f = bambu()
    expect(f.nozzles).toEqual([{ size: 0.4, other: '', type: 'brass' }])
    expect(f.filament.kind).toBe('ams')
    expect(f.connection).toBe('bambu-lan')
    expect(bedOf(f)).toEqual({ widthMm: 256, depthMm: 256, heightMm: 256 })
    expect(unlocked(f)).toEqual({ model: true, nozzle: true, connection: true, test: true })
  })

  it('sends brands without catalog models to hand setup with a firmware-based connection', () => {
    const f = pickBrand(EMPTY_FORM, 'anycubic')
    expect(f.modelId).toBe('custom')
    expect(connectionChoices(f)).toEqual(['octoprint', 'export'])
    const k = setFirmware(f, 'klipper')
    expect(connectionChoices(k)).toEqual(['moonraker', 'export'])
    expect(k.connection).toBe('moonraker')
    expect(profileIdOf(k)).toBe('generic-klipper')
  })

  it('validates a printer set up by hand', () => {
    const f = pickBrand(EMPTY_FORM, 'other')
    expect(unlocked(f).nozzle).toBe(false)
    expect(customErrors(f.custom)).toHaveProperty('width')
    const done = { ...f, custom: { ...f.custom, width: '220', depth: '220', height: '250' } }
    expect(customErrors(done.custom)).toEqual({})
    expect(unlocked(done).nozzle).toBe(true)
    expect(bedOf(done)).toEqual({ widthMm: 220, depthMm: 220, heightMm: 250 })
    const round = { ...f, custom: { ...f.custom, shape: 'circular' as const, diameter: '0', height: '300' } }
    expect(customErrors(round.custom)).toHaveProperty('diameter')
  })

  it('checks the other nozzle size range', () => {
    expect(nozzleError({ size: null, other: '0.05', type: 'brass' })).toMatch(/0.1 to 2.0/)
    expect(nozzleError({ size: null, other: '2.5', type: 'brass' })).toMatch(/0.1 to 2.0/)
    expect(nozzleError({ size: null, other: '', type: 'brass' })).toMatch(/Enter/)
    expect(nozzleError({ size: null, other: '1,2', type: 'brass' })).toBeNull()
    expect(nozzleError({ size: 0.6, other: '', type: 'brass' })).toBeNull()
  })

  it('finds models from the search box', () => {
    expect(searchSetup('p1s').models.map((m) => m.id)).toContain('bambu-p1s')
    expect(searchSetup('creal').brands.map((b) => b.id)).toEqual(['creality'])
    expect(searchSetup('').models).toEqual([])
  })
})

describe('connection validation', () => {
  it('parses addresses with scheme, port and IPv6', () => {
    expect(parseAddress('192.168.1.50')).toEqual({ host: '192.168.1.50' })
    expect(parseAddress('http://printer.local:7125/')).toEqual({ host: 'printer.local', port: 7125, scheme: 'http' })
    expect(parseAddress('[fe80::1]:80')).toEqual({ host: 'fe80::1', port: 80 })
    expect(parseAddress('999.1.1.1')).toBeNull()
    expect(parseAddress('not a host')).toBeNull()
    expect(parseAddress('')).toBeNull()
  })

  it('warns about public addresses only', () => {
    expect(looksPublic('8.8.8.8')).toBe(true)
    for (const h of ['192.168.1.5', '10.0.0.2', '172.20.1.1', '127.0.0.1', '169.254.3.3', '100.64.0.9', '192.0.2.11', 'printer.local']) expect(looksPublic(h)).toBe(false)
  })

  it('requires the Bambu fields and an 8 character access code', () => {
    const m = connectionMethod('bambu-lan')
    const empty = checkConnection(bambu(), m)
    expect(empty.ready).toBe(false)
    // The serial number is optional: SlicerX reads it from the printer's certificate.
    expect(Object.keys(empty.errors).sort()).toEqual(['accessCode', 'host'])
    const f = { ...bambu(), fields: { ...EMPTY_FORM.fields, host: '192.168.1.40', serial: '01S00A123456789' }, secretLengths: { accessCode: 6 } }
    expect(checkConnection(f, m).errors).toEqual({ accessCode: 'The access code has 8 characters.' })
    expect(checkConnection({ ...f, secretLengths: { accessCode: 8 } }, m).ready).toBe(true)
  })

  it('checks the port range and warns on a public address', () => {
    const m = connectionMethod('moonraker')
    const base = pickModel(pickBrand(EMPTY_FORM, 'voron'), 'voron-2.4-350')
    const bad = checkConnection({ ...base, fields: { ...base.fields, host: '8.8.8.8', port: '70000' } }, m)
    expect(bad.errors.port).toMatch(/1 to 65535/)
    expect(bad.warnings).toEqual([PUBLIC_WARNING])
    const inAddress = checkConnection({ ...base, fields: { ...base.fields, host: 'printer.local:99999' } }, m)
    expect(inAddress.errors.host).toBeTruthy()
  })

  it('asks PrusaLink for the password only, the user name being maker unless typed', () => {
    const m = connectionMethod('prusalink')
    const f = pickModel(pickBrand(EMPTY_FORM, 'prusa'), 'prusa-mk4s')
    const host = { ...f, fields: { ...f.fields, host: '192.168.1.9' } }
    expect(checkConnection(host, m).errors.password).toBeTruthy()
    expect(checkConnection({ ...host, secretLengths: { password: 15 } }, m).ready).toBe(true)
    expect(checkConnection({ ...host, fields: { ...host.fields, username: 'maker' }, secretLengths: { password: 8 } }, m).ready).toBe(true)
  })

  it('keeps secrets out of the view mimir reads', () => {
    const f = { ...bambu(), fields: { ...EMPTY_FORM.fields, host: '192.168.1.40', serial: '01S00A987654321' }, secretLengths: { accessCode: 8 } }
    const view = formView(f)
    expect(view['access code']).toBe('entered')
    expect(JSON.stringify(view)).not.toMatch(/12345678/)
    expect(addressOf({ ...f, fields: { ...f.fields, port: '8883' } })).toBe('192.168.1.40:8883')
  })
})

describe('setup host over the printers API', () => {
  const info: PrinterInfo = { id: 'bay-1', name: 'Bay 1', vendor: 'Bambu Lab', model: 'X1 Carbon', plugin: 'bambu-lan', host: '192.0.2.11', nozzleCount: 1 }
  const status: PrinterStatus = { printerId: 'bay-1', state: 'idle', nozzles: [{ current: 24.2, target: 0 }], bed: { current: 23.1, target: 0 }, slots: [], cameraAvailable: false, updatedAt: '' }
  const printers = { list: async () => [info], status: async () => status } as unknown as PrinterHost
  const secrets: string[] = []
  const host = { capabilities: { printers: 'sim', secureStorage: false }, printers, secrets: { set: async (_n: string, v: string) => void secrets.push(v) } } as unknown as Host
  const setup = createHostSetup(host, { stepMs: 0 })

  it('passes all four steps against a known printer', async () => {
    const seen: TestStep[][] = []
    const r = await setup.testConnection({ family: 'bambu-lan', address: '192.0.2.11', serial: '01S00A123456789', credential: '12345678' }, (s) => seen.push(s))
    expect(r.ok).toBe(true)
    expect(r.steps.every((s) => s.ok)).toBe(true)
    expect(r).toMatchObject({ nozzleC: 24, bedC: 23, state: 'idle', reportedModel: 'X1 Carbon' })
    expect(seen.length).toBeGreaterThan(3)
    expect(JSON.stringify(r)).not.toContain('12345678')
  })

  it('names the failing step and cause', async () => {
    const away = await setup.testConnection({ family: 'bambu-lan', address: '192.0.2.99', credential: '12345678' })
    expect(away).toMatchObject({ ok: false, cause: 'unreachable' })
    expect(away.steps[0]?.ok).toBe(false)
    const code = await setup.testConnection({ family: 'bambu-lan', address: '192.0.2.11', credential: '1234' })
    expect(code).toMatchObject({ ok: false, cause: 'auth' })
    expect(code.steps.map((s) => s.ok)).toEqual([true, false, null, null])
    const port = await setup.testConnection({ family: 'bambu-lan', address: '192.0.2.11:9999', credential: '12345678' })
    expect(port).toMatchObject({ cause: 'unreachable', detail: 'wrong-port' })
    const kind = await setup.testConnection({ family: 'moonraker', address: '192.0.2.11' })
    expect(kind.cause).toBe('protocol')
  })

  it('points the browser at Link or the desktop app, and the desktop app at its own bridge', async () => {
    const input = { family: 'bambu-lan', address: '192.0.2.99', credential: '12345678' }
    expect((await setup.testConnection(input)).message).toMatch(/browser app reaches printers/)
    // The desktop app starts its bridge itself; with it down, a failed test names the bridge and never the browser.
    setBridgeConnector({ automatic: true, connect: () => Promise.reject(new Error('down')) })
    try {
      const desktop = await setup.testConnection(input)
      expect(desktop.message).toMatch(/printer bridge in this app is not connected/)
      expect(desktop.message).not.toMatch(/browser app/)
    } finally {
      setBridgeConnector(null)
    }
  })

  it('adds a known printer by id and never keeps a credential without a keychain', async () => {
    localStorage.clear()
    expect(await setup.addPrinter({ profileId: 'bambu-x1-carbon', nozzleMm: 0.4, connection: { family: 'bambu-lan', address: '192.0.2.11', credential: '12345678' } })).toEqual({ printerId: 'bay-1' })
    const local = await setup.addPrinter({ profileId: 'generic-export', nozzleMm: 0.6 })
    expect(local.printerId).toMatch(/^local-/)
    expect(secrets).toEqual([])
    expect(localStorage.getItem('slicerx.setup-printers.v1')).toBeNull()
    expect(localStorage.getItem('slicerx.prefs.v1')).toContain(local.printerId)
    expect(localStorage.getItem('slicerx.prefs.v1')).not.toContain('12345678')
  })

  it('searches profiles from the catalog', async () => {
    const hits = await setup.searchProfiles('mk4s')
    expect(hits[0]).toMatchObject({ vendor: 'Prusa Research', model: expect.stringContaining('MK4S') })
  })
})
