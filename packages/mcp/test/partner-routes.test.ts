// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client reads the partner routes open on the hub, read only: sizes, times and caps, never the bytes or the relay
// routes, and no tool opens or closes one. The hub is a scripted stand-in that answers relay.partnerRoute.list as sx-link
// does (partner_route.rs) and refuses the route's other methods from an agent connection.
import { describe, expect, it } from 'vitest'
import { connect, data, text } from './helpers'
import { AGENT_CODE, scriptedLinkHub } from './helpers/scripted-hub'

const ROUTES = {
  routes: [
    { routeId: 'cm91dGUtaWQtb25lLTE2Yg', app: 'LayerMate', pairingId: 'UVFRUVFRUVFRUVFRUVFRUQ', phone: "Chris's phone", state: 'open', openedAt: 1793692800000, lastAt: 1793692860000, bytesIn: 1_200_000, bytesOut: 3_400_000, refused: 1 },
    { routeId: 'cm91dGUtaWQtdHdvLTE2Yg', app: 'QueueMate', pairingId: 'UlJSUlJSUlJSUlJSUlJSUg', phone: 'Pixel', state: 'opening', openedAt: 1793692900000, lastAt: 1793692900000, bytesIn: 0, bytesOut: 0, refused: 0 },
  ],
  caps: { maxRoutes: 4, maxChunkBytes: 262144, relay: { routes: 2, maxRoutes: 4, usedToday: 9_000_000, capPerDay: 200_000_000, routeCapPerDay: 50_000_000, idleSeconds: 300 } },
}

/** What an agent connection is refused on partner routes (partner_route.rs): opening, sending and closing. */
const NOT_FOR_AGENTS = ['relay.partnerRoute.open', 'relay.partnerRoute.send', 'relay.partnerRoute.close']

function hub() {
  return scriptedLinkHub((method) => {
    if (NOT_FOR_AGENTS.includes(method)) throw { code: 'forbidden', message: 'partner routes are for partner apps' }
    if (method === 'relay.partnerRoute.list') return ROUTES
    if (method === 'list') return []
    return {}
  })
}

const link = (h: ReturnType<typeof hub>) => ({ printers: 'link' as const, linkUrl: 'ws://127.0.0.1:47615', linkCode: AGENT_CODE, linkWebSocket: h.WS })

describe('slicerx_partner_routes', () => {
  it('is a read-only printer tool with one optional argument', async () => {
    const { client } = await connect({ printers: 'demo' })
    const tool = (await client.listTools()).tools.find((t) => t.name === 'slicerx_partner_routes')
    expect(tool?.annotations?.readOnlyHint).toBe(true)
    expect(tool?.annotations?.destructiveHint).toBe(false)
    const schema = tool?.inputSchema as { properties: object; required?: string[] }
    expect(Object.keys(schema.properties)).toEqual(['app'])
    expect(schema.required ?? []).toEqual([])
  })

  it('reads every open route with its sizes, times and the caps, and calls nothing else on the route', async () => {
    const h0 = hub()
    const h = await connect(link(h0))
    const r = await h.call('slicerx_partner_routes', {})
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<typeof ROUTES>(r)
    expect(out.routes).toEqual(ROUTES.routes)
    expect(out.caps).toEqual(ROUTES.caps)
    expect(JSON.stringify(r)).not.toContain('pr:')
    const calls = h0.sent.map((s) => s.method).filter((m) => m.startsWith('relay.'))
    expect(calls).toEqual(['relay.partnerRoute.list'])
  })

  it('narrows to one partner app', async () => {
    const h = await connect(link(hub()))
    const r = await h.call('slicerx_partner_routes', { app: 'QueueMate' })
    expect(data<typeof ROUTES>(r).routes.map((x) => x.routeId)).toEqual(['cm91dGUtaWQtdHdvLTE2Yg'])
    const none = await h.call('slicerx_partner_routes', { app: 'NobodyMate' })
    expect(data<typeof ROUTES>(none).routes).toEqual([])
  })

  it('refuses simulated printers with not_supported and no_hub', async () => {
    const demo = await connect({ printers: 'demo' })
    const r = await demo.call('slicerx_partner_routes', {})
    expect(r).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_supported', details: { reason: 'no_hub' } } } })
  })
})
