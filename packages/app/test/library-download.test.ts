// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { Listing, StoreClient, StoreResult, DownloadLink } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { fetchModel, isLibraryFormat } from '../src/features/store/download'
import { creatorUrl, dashboardUrl, privacyUrl, signInUrl } from '../src/features/store/routes'
import { NEUTRAL } from '../src/edition'

const listing = { id: 'l1', title: 'Clip' } as Listing
const store = (r: StoreResult<DownloadLink>) => ({ download: async () => r }) as unknown as StoreClient
const link = (url: string, fileName = 'clip.sx3mf'): StoreResult<DownloadLink> => ({ ok: true, value: { url, versionId: 'v', version: '1.0.0', fileName } })
const respond = (status: number, body = new Uint8Array([1, 2, 3])) => (async () => new Response(body, { status })) as unknown as typeof fetch

describe('fetching a library model', () => {
  it('asks for sign-in when the store needs a session', async () => {
    const r = await fetchModel(store({ ok: false, code: 'not_signed_in', message: 'x' }), listing, respond(200))
    expect(r).toMatchObject({ ok: false, reason: 'sign-in' })
  })
  it('returns the bytes and the file name', async () => {
    const r = await fetchModel(store(link('https://cdn.example/clip.sx3mf')), listing, respond(200))
    expect(r.ok && r.name).toBe('clip.sx3mf')
    expect(r.ok && new Uint8Array(r.bytes).length).toBe(3)
  })
  it('reports a catalog entry with no file', async () => {
    const r = await fetchModel(store(link('seed://x')), listing, respond(200))
    expect(r).toMatchObject({ ok: false, reason: 'error' })
  })
  it('reports http failures and wrong formats', async () => {
    expect(await fetchModel(store(link('https://a/b')), listing, respond(403))).toMatchObject({ ok: false, message: 'The download failed (403).' })
    expect(await fetchModel(store(link('https://a/b', 'run.exe')), listing, respond(200))).toMatchObject({ ok: false })
  })
  it('takes a Vault file only as .sx3mf, unless it is the creator downloading their own', async () => {
    for (const name of ['clip.stl', 'clip.3mf', 'clip.obj']) {
      expect(await fetchModel(store(link('https://cdn.example/x', name)), listing, respond(200))).toMatchObject({ ok: false, message: 'Clip is not available as an .sx3mf yet.' })
    }
    const own = await fetchModel(store(link('https://cdn.example/x', 'clip.stl')), listing, respond(200), true)
    expect(own.ok && own.name).toBe('clip.stl')
  })
  it('accepts sx3mf, 3mf and stl only', () => {
    expect(['a.sx3mf', 'b.3MF', 'c.stl', 'd.obj', 'e'].map(isLibraryFormat)).toEqual([true, true, true, false, false])
  })
})

describe('website links', () => {
  const edition = { ...NEUTRAL, apps: { ...NEUTRAL.apps, web: { origin: 'https://slicerx.app' } } }
  it('builds them from the edition routes', () => {
    expect(signInUrl(edition)).toBe(`https://slicerx.app${edition.routes.login}?next=${encodeURIComponent(edition.routes.studio)}`)
    expect(dashboardUrl(edition)).toBe(`https://slicerx.app${edition.routes.dashboard}`)
    expect(creatorUrl(edition, 'ada lovelace')).toBe('https://slicerx.app/creators/ada%20lovelace')
  })
  it('links the privacy section', () => {
    expect(privacyUrl(edition, 'https://github.com/o/r/tree/abc')).toBe('https://github.com/o/r/blob/main/packages/store/README.md#privacy')
    expect(privacyUrl({ ...edition, legal: { ...edition.legal, privacy: 'https://slicerx.app/privacy' } }, 'x')).toBe('https://slicerx.app/privacy')
  })
})
