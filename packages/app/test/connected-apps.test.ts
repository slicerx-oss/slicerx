// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Connected apps: the registry, the address each app takes, and the printer setup offering a connection
// that goes through an app only once that app is added.
import { describe, expect, it } from 'vitest'
import { CONNECTION_METHODS, modelById, PRINTER_MODELS } from '@slicerx/printer-catalog'
import { appHostPort, appKeyName, appUrl, CONNECTED_APPS, connectedApp, offeredConnections } from '../src/connected-apps/registry'
import { checkConnection, connectionChoices, EMPTY_FORM, pickBrand, pickConnection, pickModel, type PrinterForm } from '../src/first-run/printer-form'
import { connectionMethod } from '@slicerx/printer-catalog'

const bambu = connectedApp('bambuddy')!
const spoolman = connectedApp('spoolman')!
const x1c = (): PrinterForm => pickModel(pickBrand(EMPTY_FORM, 'bambu-lab'), 'bambu-x1-carbon')

describe('the connected apps registry', () => {
  it('lists BamBuddy and Spoolman, each with its own port, and a key only for BamBuddy', () => {
    expect(CONNECTED_APPS.map((a) => a.id).sort()).toEqual(['bambuddy', 'spoolman'])
    expect(bambu.defaultPort).toBe(8000)
    expect(bambu.key).not.toBeNull()
    expect(spoolman.defaultPort).toBe(7912)
    expect(spoolman.key).toBeNull()
    expect(appKeyName('bambuddy')).toBe('app-bambuddy')
  })

  it('every connection that goes through an app names an app in the registry', () => {
    for (const m of CONNECTION_METHODS) if (m.requiresApp) expect(connectedApp(m.requiresApp), m.id).toBeDefined()
    expect(connectionMethod('bambuddy').requiresApp).toBe('bambuddy')
  })

  it('takes a bare host, a host and port, or a full address', () => {
    expect(appUrl(bambu, '192.168.1.50')).toEqual({ url: 'http://192.168.1.50:8000' })
    expect(appUrl(bambu, '192.168.1.50:9000/')).toEqual({ url: 'http://192.168.1.50:9000' })
    expect(appUrl(bambu, 'https://bambuddy.local')).toEqual({ url: 'https://bambuddy.local:8000' })
    expect(appUrl(spoolman, 'spoolman.local')).toEqual({ url: 'http://spoolman.local:7912' })
  })

  it('refuses an empty address, a path, https for Spoolman and other schemes', () => {
    expect(appUrl(bambu, '  ')).toHaveProperty('error')
    expect(appUrl(bambu, '192.168.1.50:8000/api/v1')).toHaveProperty('error')
    expect(appUrl(spoolman, 'https://spoolman.local')).toHaveProperty('error')
    expect(appUrl(bambu, 'ftp://192.168.1.50')).toHaveProperty('error')
  })

  it('gives a printer form the host and port of an app address', () => {
    expect(appHostPort('http://192.168.1.50:8000')).toBe('192.168.1.50:8000')
    expect(appHostPort('not a url')).toBe('')
  })
})

describe('the connection picker and connected apps', () => {
  it('offers nothing new to someone who never added an app, and keeps the default connection', () => {
    const f = x1c()
    expect(connectionChoices(f)).toEqual(['bambu-lan', 'export'])
    expect(f.connection).toBe('bambu-lan')
  })

  it('offers BamBuddy once it is added, after the printer\'s own connection', () => {
    const f = x1c()
    expect(connectionChoices(f, new Set(['bambuddy']))).toEqual(['bambu-lan', 'bambuddy', 'export'])
    expect(f.connection).toBe('bambu-lan')
  })

  it('an app other than BamBuddy adds no printer connection', () => {
    expect(connectionChoices(x1c(), new Set(['spoolman']))).toEqual(['bambu-lan', 'export'])
  })

  it('keeps the order and drops only the connections whose app is missing', () => {
    expect(offeredConnections(['moonraker', 'bambuddy', 'export'], new Set())).toEqual(['moonraker', 'export'])
    expect(offeredConnections(['moonraker', 'bambuddy', 'export'], new Set(['bambuddy']))).toEqual(['moonraker', 'bambuddy', 'export'])
  })

  it('no model lists a connection that goes through an app first, so no default changes', () => {
    for (const m of PRINTER_MODELS) {
      const first = m.connections[0]
      if (first) expect(connectionMethod(first).requiresApp, m.id).toBeUndefined()
    }
    expect(modelById('bambu-x1-carbon')?.connections[0]).toBe('bambu-lan')
  })

  it('choosing BamBuddy takes the app address, so the form asks only for the BamBuddy printer id', () => {
    const f = pickConnection(x1c(), 'bambuddy', 'http://192.168.1.50:8000')
    expect(f.connection).toBe('bambuddy')
    expect(f.fields.host).toBe('192.168.1.50:8000')
    expect(connectionMethod('bambuddy').fields.map((x) => x.key)).toEqual(['serial'])
    expect(checkConnection(f, connectionMethod('bambuddy')).errors).toHaveProperty('serial')
    const ready = { ...f, fields: { ...f.fields, serial: '12' } }
    expect(Object.keys(checkConnection(ready, connectionMethod('bambuddy')).errors)).toEqual([])
    const wrong = { ...f, fields: { ...f.fields, serial: 'shed' } }
    expect(checkConnection(wrong, connectionMethod('bambuddy')).errors.serial).toMatch(/number BamBuddy uses/)
  })

  it('choosing another connection leaves the address alone', () => {
    const f = { ...x1c(), connection: 'export' as const, fields: { ...x1c().fields, host: '192.168.1.40' } }
    expect(pickConnection(f, 'bambu-lan').fields.host).toBe('192.168.1.40')
  })
})
