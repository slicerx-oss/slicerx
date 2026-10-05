// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { NEUTRAL_EDITION, parseEditionConfig, type EditionConfigInput } from '@slicerx/edition-config'
import { describe, expect, it } from 'vitest'
import { authRedirectUrl, createEditionAuth, createEditionStore, editionSignInMethods } from './edition'

const edition = (patch: Partial<EditionConfigInput>) =>
  parseEditionConfig({ ...NEUTRAL_EDITION, legal: { sourceUrl: 'https://git.example.com/slicer/tree/{commit}' }, ...patch })

const demo = edition({
  apps: { desktop: { identifier: 'com.example.demo', productName: 'Demo Slicer' }, deepLinkScheme: 'demoslicer', web: { origin: 'https://slice.example.com' } },
  features: { store: true, feed: true, cloudSlicing: false, phonePairing: false, pilot: true, demoData: true },
  auth: { providers: [{ kind: 'email' }, { kind: 'google', clientId: 'public-client-id' }] },
})

describe('edition config', () => {
  it('builds redirect URLs from the web origin and the deep link scheme', () => {
    expect(authRedirectUrl(demo, { kind: 'web' })).toBe('https://slice.example.com/auth/callback')
    expect(authRedirectUrl(demo, { kind: 'desktop' })).toBe('demoslicer://auth/callback')
    expect(authRedirectUrl(demo, { kind: 'mobile' })).toBe('demoslicer://auth/callback')
    const noOrigin = edition({ features: { store: true, demoData: true } })
    expect(authRedirectUrl(noOrigin, { kind: 'web', origin: 'http://127.0.0.1:5173' })).toBe('http://127.0.0.1:5173/auth/callback')
    expect(() => authRedirectUrl(noOrigin, { kind: 'web' })).toThrow(/apps.web.origin/)
  })

  it('reads sign-in methods from auth.providers', () => {
    expect(editionSignInMethods(demo)).toEqual(['email', 'google'])
    expect(editionSignInMethods(edition({}))).toEqual(['email'])
  })

  it('returns no store when the store is off, and no auth without a backend', () => {
    const plain = edition({})
    expect(createEditionStore(plain, { kind: 'web', origin: 'http://127.0.0.1:5173' })).toBeNull()
    expect(createEditionAuth(plain, { kind: 'desktop' })).toBeNull()
  })

  it('serves the bundled demo catalog with demoData', async () => {
    const store = createEditionStore(demo, { kind: 'web' })
    expect(store?.mode).toBe('offline')
    expect((await store?.session())?.handle).toBe('rv')
    expect((await store?.feed({ limit: 3 }))?.items).toHaveLength(3)
  })

  it('serves the demo library with moderation roles', async () => {
    const store = createEditionStore(demo, { kind: 'web' })
    expect((await store?.listListings({ limit: 100 }))?.items).toHaveLength(20)
    expect(await store?.signInWithEmail('owner@example.com')).toEqual({ ok: true, value: undefined })
    expect(await store?.myRole()).toBe('owner')
    expect(await store?.moderationQueue()).toMatchObject({ ok: true })
  })

  it('switches off the feed', async () => {
    const noFeed = edition({ ...demo, features: { ...demo.features, feed: false } })
    const store = createEditionStore(noFeed, { kind: 'web' })
    expect((await store?.feed())?.items).toEqual([])
    expect(await store?.getListing('wave-dish')).not.toBeNull()
  })

  it('offers and allows only the configured sign-in methods', async () => {
    const auth = createEditionAuth(demo, { kind: 'desktop' })
    expect(auth?.signInMethods()).toEqual(['email'])
    expect(await auth?.signInWithOAuth('github')).toMatchObject({ ok: false, code: 'forbidden' })
    const emailOff = edition({ ...demo, auth: { providers: [{ kind: 'google', clientId: 'x' }] } })
    const noEmail = createEditionAuth(emailOff, { kind: 'desktop' })
    expect(await noEmail?.signInWithEmail('rv@example.com')).toMatchObject({ ok: false, code: 'forbidden', message: 'Email sign-in is not enabled' })
  })

  it('points the Supabase client at the configured project', () => {
    const hosted = edition({
      ...demo,
      features: { ...demo.features, demoData: false },
      backend: { supabase: { url: 'https://abcdefghijklmnop.supabase.co', anonKey: 'public-anon-key-from-the-dashboard' } },
    })
    const store = createEditionStore(hosted, { kind: 'web' })
    expect(store?.mode).toBe('supabase')
    expect(store?.signInMethods()).toEqual(['email', 'google'])
  })
})

describe('deferred past v1', () => {
  it('serves no comments or collections and refuses writes', async () => {
    const s = createEditionStore(demo, { kind: 'web' })
    expect(s).not.toBeNull()
    if (!s) return
    const listing = (await s.listListings()).items[0]?.listing
    expect(listing).toBeDefined()
    if (!listing) return
    expect(await s.comments(listing.id)).toEqual([])
    expect(await s.addComment(listing.id, 'Printed it in PETG.')).toMatchObject({ ok: false, code: 'unavailable' })
    expect(await s.collections()).toEqual([])
    expect(await s.createCollection('Favorites')).toMatchObject({ ok: false, code: 'unavailable' })
    expect(await s.setInCollection('c', listing.id, true)).toMatchObject({ ok: false, code: 'unavailable' })
  })
})
