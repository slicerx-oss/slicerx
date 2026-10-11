// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A connected app's card (Home Assistant) and phones built before the kind existed: their approvals list
// still parses, and the work arrives under a key they ignore, so they show the card with no checked work.
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { ApprovalRequestSchema, ApprovalView, METHODS } from '../src/rpc'

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/)
/** `WorkSummary` and `ApprovalView` as a 0.2.4 phone has them, before the plugin kind. */
const OldWorkSummary = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('print'), printerId: z.string().max(128), file: z.object({ name: z.string().max(255), sizeBytes: z.number().int().nonnegative(), sha256: Hex64 }), opts: z.looseObject({}).optional() }),
  z.object({ kind: z.enum(['resume', 'pause', 'cancel']), printerId: z.string().max(128) }),
  z.object({ kind: z.literal('gcode'), printerId: z.string().max(128), line: z.string().max(96).regex(/^[\x20-\x7e]+$/) }),
  z.object({ kind: z.literal('adjust'), printerId: z.string().max(128), change: z.unknown() }),
])
const OldApprovalView = z.object({ request: ApprovalRequestSchema, source: z.enum(['pilot', 'pair', 'host']), requestedBy: z.string().max(64).optional(), work: OldWorkSummary.optional() })

const h = 'a'.repeat(64)
const request = { id: 'r1', sessionId: 'mcp', tool: 'home-assistant.call_service', permission: 'start', title: 'Turn on the lights', lines: [], paramsHash: h, actions: [{ action: 'plugin.call', target: 'home-assistant', paramsHash: h }], expiresAt: '2026-10-11T12:00:00Z' }
const plugin = { kind: 'plugin', printerId: '', pluginId: 'home-assistant', tool: 'call_service', input: { domain: 'switch', service: 'turn_off', entityId: 'switch.bay_2_power' } }
const pause = { request: { ...request, id: 'r2', actions: [{ action: 'printer.pause', target: 'bay-2', paramsHash: h }] }, source: 'host', work: { kind: 'pause', printerId: 'bay-2' } }

describe('connected app work for phones', () => {
  it("an older phone's list still parses, with the card and no work on it", () => {
    // The hub keeps a connected app's work under connectedAppWork (`work_key` in remote_rpc.rs).
    const list = [{ request, source: 'host', connectedAppWork: plugin }, pause]
    const old = z.array(OldApprovalView).safeParse(list)
    expect(old.success).toBe(true)
    expect(old.data?.[0]?.work).toBeUndefined()
    expect(old.data?.[1]?.work).toEqual({ kind: 'pause', printerId: 'bay-2' })
    // Had it come under `work`, the older phone would have refused the whole list.
    expect(z.array(OldApprovalView).safeParse([{ request, source: 'host', work: plugin }, pause]).success).toBe(false)
  })

  it('a current phone reads the connected app work, and refuses work it cannot hold', () => {
    const v = METHODS['approvals.list'].result.safeParse([{ request, source: 'host', connectedAppWork: plugin }])
    expect(v.success).toBe(true)
    expect(v.data?.[0]?.connectedAppWork).toMatchObject({ kind: 'plugin', pluginId: 'home-assistant', tool: 'call_service' })
    expect(ApprovalView.safeParse({ request, source: 'host', connectedAppWork: { ...plugin, pluginId: 'duet' } }).success).toBe(false)
    expect(ApprovalView.safeParse({ request, source: 'host', connectedAppWork: { ...plugin, tool: 'home-assistant.call_service' } }).success).toBe(false)
  })
})
