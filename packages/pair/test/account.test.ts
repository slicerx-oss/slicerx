// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import type { DeviceJoinRequest, PairingFlow } from '../src/client'
import { checkGrant, issueGrant } from '../src/grant'
import type { HostJoinRequest } from '../src/host'
import { createIdentity } from '../src/identity'
import { flush, pairByLink, world } from './helpers'

const ACCOUNT = 'acct-7f3a'

async function approveJoin(review: () => Promise<PairingFlow | null>, joiner: PairingFlow) {
  const reviewer = await review()
  if (!reviewer) throw new Error('nothing to review')
  const [a, b] = await Promise.all([reviewer.sas, joiner.sas])
  expect(a).toBe(b)
  joiner.confirm()
  reviewer.confirm()
  return Promise.all([joiner.result, reviewer.result])
}

describe('account link', () => {
  it('marks pairings made while both sides are signed in to the same account', async () => {
    const w = await world({ accountId: ACCOUNT })
    const phone = w.phone('Pocket', { accountId: ACCOUNT })
    await pairByLink(w, phone)
    const [d] = await w.host.devices()
    expect(d?.accountLinked).toBe(true)
    expect(d?.rights.introduce).toBe(true)
    const [h] = await phone.client.hosts()
    expect(h?.accountLinked).toBe(true)
  })

  it('a trusted phone approves a new phone, which then reaches the host through the relay', async () => {
    const w = await world({ accountId: ACCOUNT })
    const trusted = w.phone('Pocket', { accountId: ACCOUNT })
    await pairByLink(w, trusted)
    const requests: DeviceJoinRequest[] = []
    trusted.client.watchJoinRequests(w.relay.connect({ accountId: ACCOUNT }), (r) => requests.push(r))

    const fresh = w.phone('Tablet', { accountId: ACCOUNT, lan: false })
    const joiner = await fresh.client.joinAccount()
    await flush()
    expect(requests.map((r) => r.name)).toEqual(['Tablet'])
    const [joined] = await approveJoin(() => requests[0]?.review() ?? Promise.resolve(null), joiner)
    expect(joined.ok).toBe(true)
    const [pending] = await fresh.client.hosts()
    expect(pending?.pendingIntroduction).toBe(true)
    expect(pending?.name).toBe('Studio Mac')

    const conn = await fresh.client.connect(pending?.pairingId ?? '')
    expect(conn.via).toBe('relay')
    expect((await conn.printers()).length).toBeGreaterThan(0)
    conn.close()
    const devices = await w.host.devices()
    expect(devices.map((d) => [d.name, d.introducedBy ?? null])).toEqual([
      ['Pocket', null],
      ['Tablet', 'Pocket'],
    ])
    const [after] = await fresh.client.hosts()
    expect(after?.pendingIntroduction).toBe(false)
    // The second connection uses the ordinary pairing route.
    const again = await fresh.client.connect(after?.pairingId ?? '')
    again.close()
  })

  it('the host can approve a join request itself', async () => {
    const w = await world({ accountId: ACCOUNT })
    const requests: HostJoinRequest[] = []
    w.host.watchJoinRequests(w.relay.connect({ accountId: ACCOUNT }), (r) => requests.push(r))
    const fresh = w.phone('Tablet', { accountId: ACCOUNT, lan: false })
    const joiner = await fresh.client.joinAccount()
    await flush()
    const attempt = requests[0]?.review()
    if (!attempt) throw new Error('no request')
    expect(await attempt.sas).toBe(await joiner.sas)
    joiner.confirm()
    attempt.confirm()
    const [j, h] = await Promise.all([joiner.result, attempt.result])
    expect(j.ok && h.ok).toBe(true)
    const conn = await fresh.client.connect((await fresh.client.hosts())[0]?.pairingId ?? '')
    expect(conn.info.rights.request).toBe(true)
    conn.close()
  })

  it('the relay refuses account routes to other accounts', async () => {
    const w = await world({ accountId: ACCOUNT })
    const requests: DeviceJoinRequest[] = []
    const trusted = w.phone('Pocket', { accountId: ACCOUNT })
    await pairByLink(w, trusted)
    trusted.client.watchJoinRequests(w.relay.connect({ accountId: ACCOUNT }), (r) => requests.push(r))
    // Signed in to another account, but naming this one in the route.
    const intruder = w.phone('Intruder', { accountId: 'acct-other', lan: false })
    intruder.client.setAccount(ACCOUNT)
    await intruder.client.joinAccount()
    await flush()
    expect(requests).toEqual([])
  })

  it('a phone without introduce rights has nothing to offer a new device', async () => {
    const w = await world({ accountId: ACCOUNT })
    const trusted = w.phone('Pocket', { accountId: ACCOUNT })
    await pairByLink(w, trusted)
    const [d] = await w.host.devices()
    await w.host.setRights(d?.pairingId ?? '', { request: true, approve: true, introduce: false })
    const conn = await trusted.client.connect((await trusted.client.hosts())[0]?.pairingId ?? '')
    conn.close()
    const requests: DeviceJoinRequest[] = []
    trusted.client.watchJoinRequests(w.relay.connect({ accountId: ACCOUNT }), (r) => requests.push(r))
    const joiner = await w.phone('Tablet', { accountId: ACCOUNT }).client.joinAccount()
    await flush()
    expect(requests.length).toBe(1)
    expect(await requests[0]?.review()).toBeNull()
    joiner.reject()
  })
})

describe('grant checks on the host', () => {
  async function setup() {
    const w = await world({ accountId: ACCOUNT })
    const trusted = w.phone('Pocket', { accountId: ACCOUNT })
    await pairByLink(w, trusted)
    const subject = createIdentity(w.env, 'Tablet', 'android')
    const host = { identity: w.hostId.public, endpoints: { lan: [] } }
    const pairings = await w.hostStore.list()
    const ctx = { identity: w.hostId.public, accountId: ACCOUNT, pairings, revokedGrants: new Set<string>() }
    const grant = issueGrant(w.env, trusted.id, { accountId: ACCOUNT, subject: subject.public, host, rights: { request: true, approve: true, introduce: true } })
    return { w, trusted, subject, host, ctx, grant }
  }

  it('accepts a valid grant and caps rights at the issuer', async () => {
    const { w, ctx, grant } = await setup()
    const [issuer] = ctx.pairings
    if (issuer) issuer.rights = { request: true, approve: false, introduce: true }
    const r = checkGrant(w.env, grant, ctx)
    expect(r).toMatchObject({ ok: true, rights: { request: true, approve: false, introduce: true } })
  })

  it('refuses tampering, strangers, other accounts, other hosts, old grants and revoked grants', async () => {
    const { w, ctx, grant, subject, host } = await setup()
    expect(checkGrant(w.env, { ...grant, rights: { ...grant.rights, approve: true, request: false } }, ctx)).toEqual({ ok: false, reason: 'bad_signature' })
    const stranger = createIdentity(w.env, 'Stranger', 'ios')
    const byStranger = issueGrant(w.env, stranger, { accountId: ACCOUNT, subject: subject.public, host, rights: grant.rights })
    expect(checkGrant(w.env, byStranger, ctx)).toEqual({ ok: false, reason: 'unknown_issuer' })
    expect(checkGrant(w.env, grant, { ...ctx, accountId: 'acct-other' })).toEqual({ ok: false, reason: 'account_mismatch' })
    expect(checkGrant(w.env, grant, { ...ctx, accountId: null })).toEqual({ ok: false, reason: 'account_mismatch' })
    const otherHost = createIdentity(w.env, 'Other Mac', 'desktop')
    expect(checkGrant(w.env, grant, { ...ctx, identity: otherHost.public })).toEqual({ ok: false, reason: 'wrong_host' })
    expect(checkGrant(w.env, grant, { ...ctx, revokedGrants: new Set([grant.grantId]) })).toEqual({ ok: false, reason: 'revoked' })
    const noIntro = ctx.pairings.map((p) => ({ ...p, rights: { ...p.rights, introduce: false } }))
    expect(checkGrant(w.env, grant, { ...ctx, pairings: noIntro })).toEqual({ ok: false, reason: 'not_allowed' })
    w.env.advance(8 * 24 * 60 * 60 * 1000)
    expect(checkGrant(w.env, grant, ctx)).toEqual({ ok: false, reason: 'expired' })
  })

  it('a revoked introduced device cannot come back with the same grant', async () => {
    const w = await world({ accountId: ACCOUNT })
    const trusted = w.phone('Pocket', { accountId: ACCOUNT })
    await pairByLink(w, trusted)
    const requests: DeviceJoinRequest[] = []
    trusted.client.watchJoinRequests(w.relay.connect({ accountId: ACCOUNT }), (r) => requests.push(r))
    const fresh = w.phone('Tablet', { accountId: ACCOUNT, lan: false })
    const joiner = await fresh.client.joinAccount()
    await flush()
    await approveJoin(() => requests[0]?.review() ?? Promise.resolve(null), joiner)
    const saved = await fresh.store.list()
    const conn = await fresh.client.connect(saved[0]?.pairingId ?? '')
    conn.close()
    const tablet = (await w.host.devices()).find((d) => d.name === 'Tablet')
    await w.host.revoke(tablet?.pairingId ?? '')
    // Restore the phone's record as it was before first contact, grant included.
    for (const r of saved) await fresh.store.put(r)
    await expect(fresh.client.connect(saved[0]?.pairingId ?? '')).rejects.toThrow()
    expect((await w.host.devices()).map((d) => d.name)).toEqual(['Pocket'])
  })

  it('the account device list can revoke linked pairings', async () => {
    const w = await world({ accountId: ACCOUNT })
    const phone = w.phone('Pocket', { accountId: ACCOUNT })
    await pairByLink(w, phone)
    await w.host.revokeAccountDevices([phone.id.public.deviceId])
    expect(await w.host.devices()).toEqual([])
  })
})
