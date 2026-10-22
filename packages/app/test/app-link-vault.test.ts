// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// vault.list over the app link, against the real offline store client: the catalog signed in or out, the person's
// Saved list and own uploads only while signed in (signed_out otherwise), each design with what the Vault shows and its
// size from the scan (null where there is none), paged by cursor. Never a file, a hash, a link or a token.
import type { Host, StoreClient } from '@slicerx/contracts'
import { createStore } from '@slicerx/store'
import { afterEach, describe, expect, it } from 'vitest'
import { APP_LINK_METHODS, LinkError, runCall } from '../src/app-link/methods'
import { bindVaultStore, type VaultPage } from '../src/app-link/vault'

const bind = (store: StoreClient | undefined) => bindVaultStore({ store } as unknown as Host)
const list = async (args: Record<string, unknown> = {}) => (await runCall('vault.list', args)) as VaultPage
const refusal = async (args: Record<string, unknown>) => (await runCall('vault.list', args).catch((e: unknown) => e)) as LinkError

afterEach(() => {
  bindVaultStore(undefined)
})

describe('vault.list over the app link', () => {
  it('is a read, and says so when the build has no Vault', async () => {
    expect(APP_LINK_METHODS['vault.list']).toBe('read')
    const e = await refusal({})
    expect(e).toBeInstanceOf(LinkError)
    expect(e.code).toBe('not_ready')
    expect(e.message).toMatch(/has no Vault/)
  })

  it('lists the catalog with what the Vault shows and the scan size, page by page', async () => {
    bind(createStore({ offline: true }))
    const first = await list({ limit: 2 })
    expect(first.list).toBe('all')
    expect(first.signedIn).toBe(true)
    expect(first.items).toHaveLength(2)
    expect(first.next).toBe('2')
    const d = first.items[0]!
    expect(Object.keys(d).sort()).toEqual(['creator', 'id', 'license', 'liked','publishedAt', 'saved', 'slug', 'stats', 'status', 'tags', 'title', 'version'])
    expect(d.status).toBe('approved')
    expect(d.creator.handle).toMatch(/\w/)
    expect(d.version?.sizeMm).toHaveLength(3)
    for (const n of d.version!.sizeMm!) expect(n).toBeGreaterThan(0)
    expect(Object.keys(d.stats!).sort()).toEqual(['downloads', 'likes', 'makes'])
    expect(typeof d.liked).toBe('boolean')
    const second = await list({ limit: 2, cursor: first.next! })
    expect(second.items).toHaveLength(2)
    expect(second.items.map((x) => x.id)).not.toContain(d.id)
    // nothing that fetches or proves the file leaves the app
    expect(JSON.stringify([first, second])).not.toMatch(/sha256|storage|https?:|token/i)
  })

  it('gives null for a size the scan could not vouch for', async () => {
    const store = createStore({ offline: true })
    bind({
      ...store,
      listListings: async (o) => {
        const r = await store.listListings(o)
        const [a, ...rest] = r.items
        const { sizeMm: _drop, ...version } = a!.listing.currentVersion!
        return { ...r, items: [{ ...a!, listing: { ...a!.listing, currentVersion: version } }, ...rest] }
      },
    })
    const page = await list({ limit: 2 })
    expect(page.items[0]!.version!.sizeMm).toBeNull()
    expect(page.items[1]!.version!.sizeMm).toHaveLength(3)
  })

  it('reads the person\'s Saved list and own uploads only while signed in', async () => {
    const out = createStore({ offline: true, signedInAs: null })
    bind(out)
    const all = await list({ limit: 1 })
    expect(all.signedIn).toBe(false)
    expect(all.items[0]).toMatchObject({ liked: null, saved: null })
    for (const which of ['saved', 'mine']) {
      const e = await refusal({ list: which })
      expect(e.code, which).toBe('signed_out')
      expect(e.message).toMatch(/nobody is signed in to the Vault/)
    }

    const member = createStore({ offline: true })
    bind(member)
    const pick = (await member.listListings({ limit: 3 })).items.map((c) => c.listing.id)
    for (const id of pick) expect((await member.setSaved(id, true)).ok).toBe(true)
    const saved = await list({ list: 'saved', limit: 2 })
    expect(saved).toMatchObject({ list: 'saved', signedIn: true, next: '2' })
    expect(saved.items.every((d) => d.saved === true)).toBe(true)
    const rest = await list({ list: 'saved', limit: 2, cursor: '2' })
    expect(rest.items).toHaveLength(1)
    expect(rest.next).toBeNull()
    expect(new Set([...saved.items, ...rest.items].map((d) => d.id))).toEqual(new Set(pick))

    bind(createStore({ offline: true, signedInAs: 'oddfellow' }))
    const mine = await list({ list: 'mine', limit: 50 })
    expect(mine.items).toHaveLength(6)
    expect(mine.items.map((d) => d.status).sort()).toEqual(['approved', 'approved', 'approved', 'approved', 'rejected', 'removed'])
    expect(new Set(mine.items.map((d) => d.creator.handle)).size).toBe(1)
    expect(mine.next).toBeNull()
  })

  it('filters by words and tag as the Vault grid does', async () => {
    const store = createStore({ offline: true })
    bind(store)
    const tag = (await store.listListings({ limit: 1 })).items[0]!.listing.tags[0]!
    const tagged = await list({ tag, limit: 50 })
    expect(tagged.items.length).toBeGreaterThan(0)
    expect(tagged.items.every((d) => d.tags.some((t) => t.toLowerCase() === tag.toLowerCase()))).toBe(true)
    expect((await list({ query: 'zzqx no such design', limit: 50 })).items).toEqual([])
  })

  it('refuses arguments it does not take', async () => {
    bind(createStore({ offline: true }))
    for (const bad of [{ list: 'liked' }, { sort: 'popular', list: 'saved' }, { sort: 'oldest' }, { limit: 0 }, { limit: 51 }, { limit: 2.5 }, { cursor: 'abc' }, { query: 'x'.repeat(101) }, { secret: 1 }]) {
      expect((await refusal(bad)).code, JSON.stringify(bad)).toBe('invalid_input')
    }
  })

  it('passes a store failure on as a refusal', async () => {
    const store = createStore({ offline: true })
    bind({ ...store, listListings: async () => Promise.reject(new Error('network down')) })
    const e = await refusal({})
    expect(e.code).toBe('refused')
    expect(e.message).toBe('the Vault could not be read: network down')
  })
})
