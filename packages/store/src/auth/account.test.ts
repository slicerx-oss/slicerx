// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { generateSeed, seedId } from '../seed/generate'
import { createAuth } from './index'

const fixed = () => new Date('2026-09-30T20:00:00Z')
let n = 0
const auth = (signedInAs: string | null = 'rv') => createAuth({ offline: true, signedInAs, now: fixed, newId: () => seedId(`account-test:${n++}`), seed: generateSeed() })

describe('data export (offline)', () => {
  it('bundles the member profile and activity, and nothing of anyone else', async () => {
    const r = await auth().exportMyData()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const doc = r.value
    expect(doc.format).toBe('slicerx-account-export')
    expect((doc['profile'] as { handle: string }).handle).toBe('rv')
    const rv = seedId('user:rv')
    for (const key of ['likes', 'downloads', 'follows', 'comments', 'makes']) {
      const rows = doc[key] as { user_id: string }[]
      expect(Array.isArray(rows), key).toBe(true)
      expect(rows.every((x) => x.user_id === rv), key).toBe(true)
    }
    expect((doc['collections'] as unknown[]).length).toBe(2)
    expect((doc['likes'] as unknown[]).length).toBeGreaterThan(0)
    for (const gone of ['subscriptions', 'licenses', 'boosts', 'print_events']) expect(gone in doc, gone).toBe(false)
  })

  it('lists the creator page, listings, versions and links of a creator', async () => {
    const r = await auth('ferro').exportMyData()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const doc = r.value
    expect((doc['creator_page'] as { handle: string }[]).map((c) => c.handle)).toEqual(['ferro-labs'])
    expect((doc['listings'] as unknown[]).length).toBe(5)
    expect((doc['listing_versions'] as unknown[]).length).toBeGreaterThanOrEqual(5)
    expect((doc['creator_links'] as unknown[]).length).toBe(3)
    expect((doc['paired_devices'] as unknown[]).length).toBe(0)
  })

  it('includes paired devices', async () => {
    const a = auth()
    await a.addPairedDevice({ deviceId: 'device-export-1', name: 'Phone', platform: 'android', signPub: 'B'.repeat(43) })
    const r = await a.exportMyData()
    expect(r.ok && (r.value['paired_devices'] as unknown[]).length).toBe(1)
  })

  it('needs a signed-in member', async () => {
    expect(await auth(null).exportMyData()).toMatchObject({ ok: false, code: 'not_signed_in' })
  })
})

describe('account deletion (offline)', () => {
  it('schedules deletion 30 days out, revokes tokens, and can be canceled', async () => {
    const a = auth()
    const t = await a.createApiToken({ name: 'CLI', scopes: ['cli'] })
    expect(t.ok).toBe(true)
    const plan = await a.requestAccountDeletion()
    expect(plan).toMatchObject({ ok: true, value: { graceDays: 30, purgeAfter: '2026-10-30T20:00:00.000Z' } })
    if (plan.ok) {
      expect(plan.value.removed.length).toBeGreaterThan(0)
      expect(plan.value.kept.some((k) => k.includes('audit'))).toBe(true)
    }
    expect((await a.apiTokens()).every((x) => x.revokedAt)).toBe(true)
    expect(await a.createApiToken({ name: 'After', scopes: ['cli'] })).toMatchObject({ ok: false, code: 'conflict' })
    expect(await a.pendingAccountDeletion()).toEqual({ requestedAt: '2026-09-30T20:00:00.000Z', purgeAfter: '2026-10-30T20:00:00.000Z' })
    expect(await a.cancelAccountDeletion()).toEqual({ ok: true, value: undefined })
    expect(await a.pendingAccountDeletion()).toBeNull()
    expect(await a.cancelAccountDeletion()).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('lets a creator ask for deletion, and refuses the owner', async () => {
    expect(await auth('ferro').requestAccountDeletion()).toMatchObject({ ok: true })
    expect(await auth('owner').requestAccountDeletion()).toMatchObject({ ok: false, code: 'conflict', message: expect.stringContaining('owner account cannot be deleted') })
    expect(await auth(null).requestAccountDeletion()).toMatchObject({ ok: false, code: 'not_signed_in' })
  })

  it('publishes the same policy it applies', async () => {
    const policy = await auth(null).accountDeletionPolicy()
    expect(policy.graceDays).toBe(30)
    expect(policy.removed).toContain('Your paired devices')
    expect(policy.removed).toContain('Your creator page and every model you uploaded, with their files')
    expect(policy.kept).toContain('Moderation audit entries about your account, with the actor and target ids only')
    expect(JSON.stringify(policy)).not.toMatch(/pool|licen[sc]e|subscri|boost/i)
  })
})

describe('paired devices (offline)', () => {
  const device = (n: number) => ({ deviceId: `device-test-${n}`, name: `Phone ${n}`, platform: 'ios' as const, signPub: 'C'.repeat(43) })

  it('links, lists newest first and revokes a device', async () => {
    let t = 0
    const a = createAuth({ offline: true, now: () => new Date(Date.UTC(2026, 8, 30, 20, 0, t++)), newId: () => seedId(`dev-test:${n++}`), seed: generateSeed() })
    const first = await a.addPairedDevice(device(1))
    const second = await a.addPairedDevice(device(2))
    expect(first).toMatchObject({ ok: true, value: { name: 'Phone 1', platform: 'ios', deviceId: 'device-test-1' } })
    expect((await a.listPairedDevices()).map((d) => d.name)).toEqual(['Phone 2', 'Phone 1'])
    if (!first.ok || !second.ok) return
    expect(await a.revokePairedDevice(first.value.id)).toEqual({ ok: true, value: undefined })
    const listed = await a.listPairedDevices()
    expect(listed.find((d) => d.id === first.value.id)?.revokedAt).toBeDefined()
    expect(listed.find((d) => d.id === second.value.id)?.revokedAt).toBeUndefined()
    expect(await a.revokePairedDevice(first.value.id)).toMatchObject({ ok: false, code: 'conflict' })
    expect(await a.revokePairedDevice(seedId('nope'))).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('checks the device before linking it', async () => {
    const a = auth()
    expect(await a.addPairedDevice({ ...device(1), deviceId: 'short' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await a.addPairedDevice({ ...device(1), signPub: 'nope' })).toMatchObject({ ok: false, code: 'invalid' })
    expect((await a.addPairedDevice(device(1))).ok).toBe(true)
    expect(await a.addPairedDevice(device(1))).toMatchObject({ ok: false, code: 'conflict' })
    expect(await auth(null).addPairedDevice(device(1))).toMatchObject({ ok: false, code: 'not_signed_in' })
  })

  it('allows 10 active devices, and a revoked one frees a place', async () => {
    const a = auth()
    const made = []
    for (let i = 0; i < 10; i++) made.push(await a.addPairedDevice(device(i)))
    expect(await a.addPairedDevice(device(10))).toMatchObject({ ok: false, code: 'conflict', message: 'device limit reached; revoke one first' })
    const first = made[0]
    if (first?.ok) await a.revokePairedDevice(first.value.id)
    expect((await a.addPairedDevice(device(10))).ok).toBe(true)
  })

  it('notices a device linked or revoked, at once', async () => {
    const a = auth()
    const seen: string[] = []
    const off = a.onPairedDeviceChange((e) => seen.push(`${e.type}:${e.device.name}`))
    const added = await a.addPairedDevice(device(7))
    if (added.ok) await a.revokePairedDevice(added.value.id)
    off()
    await a.addPairedDevice(device(8))
    expect(seen).toEqual(['added:Phone 7', 'revoked:Phone 7'])
  })

  it('keeps devices private to their member', async () => {
    const a = auth()
    await a.addPairedDevice(device(1))
    expect(await a.listPairedDevices()).toHaveLength(1)
    await a.signInWithEmail('ash@example.com')
    expect(await a.listPairedDevices()).toEqual([])
  })
})

describe('token safety (offline)', () => {
  it('stores a rate limit per token and rejects out-of-range limits', async () => {
    const a = auth()
    const t = await a.createApiToken({ name: 'MCP', scopes: ['mcp'], rateLimitPerMinute: 120 })
    expect(t).toMatchObject({ ok: true, value: { token: { rateLimitPerMinute: 120 } } })
    expect(await a.createApiToken({ name: 'x', scopes: ['mcp'], rateLimitPerMinute: 0 })).toMatchObject({ ok: false, code: 'invalid' })
    expect((await a.createApiToken({ name: 'Default', scopes: ['cli'] })).ok && (await a.apiTokens()).find((x) => x.name === 'Default')?.rateLimitPerMinute).toBe(60)
  })

  it('revokes all tokens at once', async () => {
    const a = auth()
    await a.createApiToken({ name: 'One', scopes: ['cli'] })
    await a.createApiToken({ name: 'Two', scopes: ['mcp'] })
    expect(await a.revokeAllApiTokens()).toEqual({ ok: true, value: { revoked: 2 } })
    expect(await a.revokeAllApiTokens()).toEqual({ ok: true, value: { revoked: 0 } })
  })
})
