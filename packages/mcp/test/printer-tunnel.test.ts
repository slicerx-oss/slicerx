// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client reads a printer reached through Obico the way it reads any printer, and cannot connect one: no tool takes a
// tunnel address or its password. The hub is replaced by a fake that answers as sx-link's printers.tunnel does.
import { describe, expect, it } from 'vitest'
import type { PrinterHost, TunnelReport } from '@slicerx/contracts'
import { connect, data } from './helpers'

const HOST = 'abc123.tunnels.app.obico.io'
const report = (over: Partial<TunnelReport> = {}): TunnelReport => ({
  printerId: 'far',
  tunnel: 'obico',
  host: HOST,
  camera: false,
  problem: null,
  connected: true,
  usage: { usedBytes: 120_000_000, capBytes: 300_000_000, leftBytes: 180_000_000, unlimited: false, resetInSeconds: 86_400 },
  prediction: { score: 0.12 },
  ...over,
})

/** The hub's refusal, as the link client rejects with it. */
const refusal = (code: string, reason?: string) => Object.assign(new Error(`refused: ${code}`), { code, ...(reason ? { details: { reason } } : {}) })

async function withHost(patch: Partial<PrinterHost>) {
  const h = await connect()
  Object.assign(h.ctx.printers!.host, patch)
  return h
}

describe('slicerx_printer_tunnel', () => {
  it('is a read-only printer tool', async () => {
    const { client } = await connect()
    const tool = (await client.listTools()).tools.find((t) => t.name === 'slicerx_printer_tunnel')
    expect(tool?.annotations?.readOnlyHint).toBe(true)
    expect(tool?.annotations?.destructiveHint).toBe(false)
    expect(Object.keys((tool?.inputSchema as { properties: object }).properties)).toEqual(['printerId'])
  })

  it('returns the tunnel, its data, the failure score and the camera note', async () => {
    const asked: string[] = []
    const h = await withHost({
      tunnel: async (id) => {
        asked.push(id)
        return report()
      },
    })
    const r = await h.call('slicerx_printer_tunnel', { printerId: 'far' })
    expect(r.isError).toBeFalsy()
    expect(asked).toEqual(['far'])
    expect(data(r)).toEqual({
      printerId: 'far',
      tunnel: 'obico',
      host: HOST,
      connected: true,
      problem: null,
      message: null,
      usage: { usedBytes: 120_000_000, capBytes: 300_000_000, leftBytes: 180_000_000, unlimited: false, resetInSeconds: 86_400 },
      prediction: { score: 0.12 },
      camera: { available: false, reason: 'camera_off_tunnel' },
    })
  })

  it('says what the tunnel refused in plain words', async () => {
    const h = await withHost({ tunnel: async () => report({ problem: 'data_limit', connected: false, prediction: null }) })
    const r = data<{ problem: string; message: string }>(await h.call('slicerx_printer_tunnel', { printerId: 'far' }))
    expect(r.problem).toBe('data_limit')
    expect(r.message).toMatch(/free Obico data is used up/)
  })

  it('refuses cleanly when there is no tunnel', async () => {
    // Simulated printers have no tunnels at all.
    const demo = await connect()
    expect(await demo.call('slicerx_printer_tunnel', { printerId: 'bay-1' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported', details: { reason: 'no_tunnel' } } } })
    // The hub refuses a printer on the local network, or one it does not know.
    const h = await withHost({
      tunnel: async (id) => {
        throw id === 'near' ? refusal('not_supported', 'no_tunnel') : refusal('not_found')
      },
    })
    expect(await h.call('slicerx_printer_tunnel', { printerId: 'near' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported', details: { reason: 'no_tunnel' } } } })
    expect(await h.call('slicerx_printer_tunnel', { printerId: 'gone' })).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_found' } } })
  })
})

describe('the camera through a tunnel', () => {
  it('slicerx_printer_snapshot refuses with the reason instead of an image', async () => {
    const h = await withHost({
      snapshot: async () => {
        throw refusal('not_supported', 'camera_off_tunnel')
      },
    })
    const r = await h.call('slicerx_printer_snapshot', { printer_id: 'far' })
    expect(r).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported', details: { reason: 'camera_off_tunnel' } } } })
    expect(JSON.stringify(r.content)).toMatch(/off while it is reached through Obico/)
  })
})

describe('no client connects a printer through Obico', () => {
  it('no tool takes a tunnel, an address with a password or a credential', async () => {
    const { client } = await connect()
    for (const t of (await client.listTools()).tools) {
      const schema = JSON.stringify(t.inputSchema)
      expect(schema, t.name).not.toMatch(/"(tunnel|tunnelUrl|tunnel_url|credential|password)"\s*:/)
      if (t.name !== 'slicerx_printer_tunnel' && t.name !== 'slicerx_printer_snapshot') expect(`${t.description ?? ''} ${schema}`, t.name).not.toMatch(/obico/i)
    }
  })
})
