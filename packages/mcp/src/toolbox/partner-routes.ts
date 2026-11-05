// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Partner routes as the hub holds them, read only: a partner app's sealed byte stream to its own paired phone over the
// relay. Sizes and times only; the bytes and the relay routes never reach a client. Opening a route takes the partner
// app's own key, and closing one is the person's (Settings, Devices) or that partner's.
import { productName } from '@slicerx/contracts'
import type { PartnerRouteList } from '@slicerx/link-client'
import { z } from 'zod'
import { ToolInputError } from '../models'
import { serverTool, type ServerToolDeps } from './deps'

interface RouteReads {
  partnerRoutes: { list(): Promise<PartnerRouteList> }
}

function readsOf(host: unknown): RouteReads | undefined {
  const h = host as Partial<RouteReads> | undefined
  return typeof h?.partnerRoutes?.list === 'function' ? (h as RouteReads) : undefined
}

const mb = (n: number): string => `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`

export default (d: ServerToolDeps) => {
  const printers = d.printers
  if (!printers) return null
  return serverTool({
    name: 'partner_routes',
    title: 'Partner routes',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'printers',
    ungated: true,
    description: `Read the partner routes open on the ${productName()} hub: each partner app's sealed byte stream between its desktop app and its own paired phone over the relay. Each route has its routeId, the partner app's name (app), the phone it reaches (pairingId and phone), state (opening or open), openedAt and lastAt (Unix milliseconds), bytesIn (from the phone) and bytesOut (to it), and refused, the frames on the route that were not its sealed bytes and were dropped. caps has the hub's maxRoutes and maxChunkBytes and, once the hub has heard the relay's quota, the relay's caps: maxRoutes per account, routeCapPerDay and capPerDay in bytes per UTC day, idleSeconds, and this account's routes and usedToday. A route carries bytes only, never a hub method, a printer command or a card. A partner key sees only its own routes. Opening a route takes the partner app's key (relay.partnerRoute.open); closing one is done by the person in Settings, Devices or by that partner, never by this tool. Simulated printers have no hub and are refused with not_supported.`,
    input: z.object({ app: z.string().min(1).max(64).optional().describe('Only the routes of this partner app, by the name its partner key was made with, such as "LayerMate".') }),
    hints: { idempotent: true, openWorld: true },
    async run(args) {
      const reads = printers.kind === 'link' ? readsOf(printers.host) : undefined
      if (!reads) throw new ToolInputError(`Partner routes run through the ${productName()} hub. These printers have none.`, 'not_supported', { reason: 'no_hub' })
      const all = await reads.partnerRoutes.list()
      const routes = args.app ? all.routes.filter((r) => r.app === args.app) : all.routes
      d.gate.log.append({ tool: 'partner_routes', permission: 'read', decision: 'read', input_hash: args.app ?? '*', ok: true })
      const moved = routes.reduce((n, r) => n + r.bytesIn + r.bytesOut, 0)
      const relay = all.caps.relay
      const summary = routes.length
        ? `${routes.length} partner route${routes.length === 1 ? '' : 's'} open, ${mb(moved)} moved${relay ? `; ${mb(relay.usedToday)} of ${mb(relay.capPerDay)} used today` : ''}`
        : `No partner routes open${args.app ? ` for ${args.app}` : ''}`
      return { summary, structured: { routes, caps: all.caps } }
    },
  })
}
