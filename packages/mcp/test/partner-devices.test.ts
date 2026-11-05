// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A client reads back partner phones and phone alerts through the hub, as sx-link answers `partners.devices` and
// `push.status` to an agent connection. Neither tool changes anything; demo printers have no hub and are refused.
import { describe, expect, it } from 'vitest'
import { connect, data } from './helpers'
import { AGENT_CODE, scriptedLinkHub } from './helpers/scripted-hub'

const DEVICES = {
  remoteAccess: true,
  devices: [
    { pairingId: 'AAAAAAAAAAAAAAAAAAAAAA', partner: 'Example Phone', name: 'Pixel 8', platform: 'android', rights: { request: true, approve: false }, addedAt: '2026-11-05T08:00:00.000Z', online: true, relayBytesToday: 4096, push: { provider: 'expo', platform: 'android' } },
  ],
  limits: { partnerPhones: 8, relayBytesPerDay: 268435456 },
}
const PUSH = {
  sending: true,
  registrations: [
    { tokenEnd: 'ner001', platform: 'android', prefs: { printDone: true, printFailed: true, attention: true, approvals: false }, tag: 'AAAAAAAAAAAAAAAAAAAAAA', createdAt: '2026-11-05T08:01:00.000Z', provider: 'expo', partner: 'Example Phone', gatewayHost: null, sentThisHour: 2 },
    { tokenEnd: 'own123', platform: 'ios', prefs: { printDone: true, printFailed: true, attention: true, approvals: true }, tag: 'own', createdAt: '2026-11-05T07:00:00.000Z', provider: 'expo' },
  ],
  own: 1,
  partners: 1,
  limits: { partnerPushesPerHour: 30, partnerRegistrations: 16, registrations: 32 },
}

function hub() {
  const calls: string[] = []
  const h = scriptedLinkHub((method) => {
    calls.push(method)
    if (method === 'list') return []
    if (method === 'partners.devices') return DEVICES
    if (method === 'push.status') return PUSH
    if (method.startsWith('remote.') || method === 'push.registerPartner') throw { code: 'forbidden', message: `${method} is for the app` }
    return {}
  })
  return { ...h, calls }
}

const link = (h: ReturnType<typeof hub>) => ({ printers: 'link' as const, linkUrl: 'ws://127.0.0.1:47615', linkCode: AGENT_CODE, linkWebSocket: h.WS })

describe('slicerx_partner_devices and slicerx_push_status', () => {
  it('are read-only tools that take no arguments', async () => {
    const { client } = await connect({ printers: 'demo' })
    const tools = (await client.listTools()).tools
    for (const name of ['slicerx_partner_devices', 'slicerx_push_status']) {
      const t = tools.find((x) => x.name === name)
      expect(t?.annotations?.readOnlyHint, name).toBe(true)
      expect(t?.annotations?.destructiveHint, name).toBe(false)
      expect(Object.keys((t?.inputSchema as { properties?: object }).properties ?? {}), name).toEqual([])
    }
  })

  it('refuse demo printers, which have no hub', async () => {
    const h = await connect({ printers: 'demo' })
    for (const name of ['slicerx_partner_devices', 'slicerx_push_status']) {
      const r = await h.call(name, {})
      expect(r.isError, name).toBe(true)
    }
  })

  it('read the partner phones and alerts the hub holds, never a token or key', async () => {
    const s = hub()
    const h = await connect(link(s))
    const d = await h.call('slicerx_partner_devices', {})
    expect(d.isError).toBeFalsy()
    expect(data(d)).toEqual(DEVICES)
    const p = await h.call('slicerx_push_status', {})
    expect(p.isError).toBeFalsy()
    expect(data(p)).toEqual(PUSH)
    expect(s.calls).toEqual(expect.arrayContaining(['partners.devices', 'push.status']))
    expect(s.calls.filter((m) => m.startsWith('remote.') || m === 'push.registerPartner')).toEqual([])
  })
})
