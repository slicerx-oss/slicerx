// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs against a local or LAN development stack only, and is skipped unless its URL and anon key
// are in the environment (see README.md, "Integration tests"). It drives the
// real magic link through the local mail catcher, including the PKCE exchange.
import { describe, expect, it } from 'vitest'
import { ACCOUNT_DELETION_POLICY } from './auth/account'
import { memoryAuthStorage } from './auth/callbacks'
import { createStore } from './index'

const url = process.env.SLICERX_SUPABASE_URL ?? ''
const anonKey = process.env.SLICERX_SUPABASE_ANON_KEY ?? ''
// Test only: the stack's mail catcher, to read the magic link.
const mailUrl = process.env.MAILPIT_URL ?? ''
// Loopback or a private LAN address only, so these tests never touch a hosted project.
const local = /^http:\/\/(127\.0\.0\.1|localhost|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+):\d+$/.test(url)
const redirect = 'http://127.0.0.1:5173/auth/callback'

const client = () => createStore({ url, anonKey, auth: { redirectUrl: () => redirect, storage: memoryAuthStorage() } })

async function magicLinkFor(email: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${mailUrl}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    const list = (await res.json()) as { messages?: { ID: string }[] }
    const id = list.messages?.[0]?.ID
    if (id) {
      const msg = (await (await fetch(`${mailUrl}/api/v1/message/${id}`)).json()) as { Text?: string; HTML?: string }
      const link = /(http:\/\/[^\s"<>]+\/auth\/v1\/verify\?[^\s"<>]+)/.exec(`${msg.Text ?? ''} ${msg.HTML ?? ''}`)?.[1]
      if (link) return link.replaceAll('&amp;', '&')
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`no magic link for ${email}`)
}

/** Signs in as a seeded account through the magic link and the PKCE exchange. */
async function signInAs(email: string) {
  const s = client()
  await fetch(`${mailUrl}/api/v1/messages`, { method: 'DELETE' })
  expect(await s.signInWithEmail(email)).toEqual({ ok: true, value: undefined })
  const verify = await fetch(await magicLinkFor(email), { redirect: 'manual' })
  const location = verify.headers.get('location') ?? ''
  expect(location.startsWith(redirect)).toBe(true)
  const done = await s.completeSignIn(location)
  expect(done.ok).toBe(true)
  return s
}

describe.skipIf(!local || !anonKey)('supabase store (local stack)', () => {
  it('serves the approved library to an anonymous visitor', async () => {
    const s = client()
    const page = await s.listListings({ limit: 100 })
    expect(page.items).toHaveLength(20)
    expect(page.items.every((i) => i.listing.status === 'approved')).toBe(true)
    expect(page.items[0]?.listing.stats).toBeDefined()
    expect(await s.getListing('trilobite-coaster-set')).toBeNull()
    expect(await s.getListing('wizard-tower-terrain')).toBeNull()
    const kestrel = await s.getCreatorByHandle('kestrel-parts')
    expect(kestrel?.links.map((l) => l.kind)).toEqual(['website', 'github', 'kofi'])
    expect(kestrel?.featured.map((l) => l.slug)).toEqual(['filament-spool-holder', 'bench-vise-jaw-pads'])
    expect(kestrel?.listings).toHaveLength(4)
    expect((await s.listCreators()).map((c) => c.handle)).toHaveLength(5)
    expect(await s.getModerationMode()).toBe('owner-approves-all')
    expect(await s.getLibrarySettings()).toEqual({ moderationMode: 'owner-approves-all', maxFileMb: 100, allowedFormats: ['3mf', 'sx3mf', 'stl'] })
    expect(await s.myRole()).toBeNull()
  })

  it('downloads an approved file signed out through a short grant', async () => {
    const s = client()
    const dish = await s.getListing('wave-dish')
    const r = await s.download(dish?.listing.id ?? '')
    if (!r.ok) throw new Error(r.message)
    expect(r.value.fileName).toBe('wave-dish-1.0.0.3mf')
    expect(r.value.url).toContain('/storage/v1/object/authenticated/listing-files/')
    expect(r.value.headers?.['x-sx-download-grant']).toMatch(/^sxg_[0-9a-f]{48}$/)
  })

  it('refuses member writes before sign-in', async () => {
    const s = client()
    expect(await s.like('00000000-0000-5000-8000-000000000000')).toMatchObject({ ok: false, code: 'not_signed_in' })
    // Signed-out downloads are allowed; an unknown listing is simply not found.
    expect(await s.download('00000000-0000-5000-8000-000000000000')).toMatchObject({ ok: false, code: 'not_found' })
    expect(await s.uploadVersion('00000000-0000-5000-8000-000000000000', { name: 'a.3mf', version: '1.0.0', bytes: new Uint8Array([0x50, 0x4b]), format: '3mf' })).toMatchObject({ ok: false, code: 'not_signed_in' })
    // Checked before any network call, signed in or not.
    expect(await s.uploadVersion('x', { name: 'A.3MF', version: '1.0.0', bytes: new Uint8Array([1]), format: '3mf' })).toMatchObject({ ok: false, code: 'invalid' })
  })

  it.skipIf(!mailUrl)('signs in with a magic link through PKCE and uses the account', async () => {
    const s = await signInAs('rv@example.com')
    expect(await s.session()).toMatchObject({ handle: 'rv', role: 'member' })
    expect(await s.myRole()).toBe('member')
    const access = await s.getAccessToken()
    const claims = JSON.parse(Buffer.from((access ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: string; role?: string }
    expect(claims.role).toBe('authenticated')
    expect(claims.sub).toBe((await s.session())?.userId)
    expect((await s.collections()).map((c) => c.name).sort()).toEqual(['Desk upgrades', 'Tabletop night'])
    expect(await s.moderationQueue()).toEqual({ ok: true, value: [] })
    expect(await s.rejectListing('00000000-0000-5000-8000-000000000000', 'ab')).toMatchObject({ ok: false, code: 'invalid' })
    expect(await s.approveListing('00000000-0000-5000-8000-000000000000')).toMatchObject({ ok: false, code: 'forbidden' })

    const token = await s.createApiToken({ name: 'Integration test', scopes: ['cli'], expiresInDays: 1 })
    expect(token).toMatchObject({ ok: true, value: { token: { name: 'Integration test', scopes: ['cli'] } } })
    if (token.ok) {
      expect(token.value.secret).toMatch(/^sxk_[0-9a-f]{64}$/)
      expect((await s.apiTokens()).some((t) => t.id === token.value.token.id)).toBe(true)
      expect(await s.revokeApiToken(token.value.token.id)).toEqual({ ok: true, value: undefined })
    }
    expect((await s.revokeAllApiTokens()).ok).toBe(true)

    const exported = await s.exportMyData()
    expect(exported).toMatchObject({ ok: true, value: { format: 'slicerx-account-export', profile: { handle: 'rv' } } })
    if (exported.ok) {
      for (const key of ['paired_devices', 'likes', 'downloads', 'follows', 'comments', 'makes', 'collections', 'creator_page', 'listings', 'listing_versions', 'creator_links']) {
        expect(Array.isArray(exported.value[key]), key).toBe(true)
      }
      for (const gone of ['subscriptions', 'licenses', 'boosts', 'print_events']) expect(gone in exported.value, gone).toBe(false)
    }
    expect(await s.accountDeletionPolicy()).toEqual(ACCOUNT_DELETION_POLICY)
    const plan = await s.requestAccountDeletion()
    expect(plan).toMatchObject({ ok: true, value: { graceDays: 30 } })
    expect((await s.pendingAccountDeletion())?.purgeAfter).toBe(plan.ok ? plan.value.purgeAfter : '')
    expect(await s.cancelAccountDeletion()).toEqual({ ok: true, value: undefined })
    expect(await s.pendingAccountDeletion()).toBeNull()
    await s.signOut()
    expect(await s.session()).toBeNull()
    expect(await s.getAccessToken()).toBeNull()
  })

  it.skipIf(!mailUrl)('links, lists and revokes a paired device, and reports it through Realtime', async () => {
    const s = await signInAs('cam@example.com')
    const events: string[] = []
    const off = s.onPairedDeviceChange((e) => events.push(`${e.type}:${e.device.deviceId}`))
    await new Promise((r) => setTimeout(r, 1500))
    const deviceId = `device-it-${Date.now()}`
    const added = await s.addPairedDevice({ deviceId, name: 'Test phone', platform: 'ios', signPub: 'D'.repeat(43) })
    expect(added).toMatchObject({ ok: true, value: { deviceId, name: 'Test phone' } })
    if (!added.ok) return
    expect((await s.listPairedDevices()).some((d) => d.id === added.value.id && !d.revokedAt)).toBe(true)
    expect(await s.revokePairedDevice(added.value.id)).toEqual({ ok: true, value: undefined })
    expect(await s.revokePairedDevice(added.value.id)).toMatchObject({ ok: false, code: 'conflict' })
    for (let i = 0; i < 50 && events.length < 2; i++) await new Promise((r) => setTimeout(r, 100))
    off()
    expect(events).toEqual([`added:${deviceId}`, `revoked:${deviceId}`])
    await s.signOut()
  }, 20_000)

  it.skipIf(!mailUrl)('shows the review queue and audit log to a moderator, who cannot approve in owner mode', async () => {
    const s = await signInAs('moderator@example.com')
    expect(await s.myRole()).toBe('moderator')
    const queue = await s.moderationQueue()
    expect(queue.ok && queue.value.map((q) => q.title).sort()).toEqual(['Anchor cabinet pull', 'Chain link cable guide', 'Trilobite coaster set'])
    expect(queue.ok && queue.value.every((q) => q.ready)).toBe(true)
    const pending = queue.ok ? queue.value[0] : undefined
    expect(pending && (await s.approveListing(pending.listingId))).toMatchObject({ ok: false, code: 'forbidden', message: 'you cannot approve uploads in the current moderation mode' })
    expect(pending && (await s.rejectListing(pending.listingId, ''))).toMatchObject({ ok: false, code: 'invalid' })
    const log = await s.auditLog({ limit: 5 })
    expect(log.ok && log.value).toHaveLength(5)
    expect(await s.setModerationMode('moderators')).toMatchObject({ ok: false, code: 'forbidden', message: 'only the owner can change the moderation mode' })
    expect(await s.banUser('00000000-0000-5000-8000-000000000000', 'Spam links')).toMatchObject({ ok: false })
    await s.signOut()
  })
})
