// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { neutralEdition } from '@slicerx/edition-config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@slicerx/edition-config', async (orig) => ({ ...(await orig<typeof import('@slicerx/edition-config')>()), UPSTREAM_REPORTS: { url: 'https://upstream.example', anonKey: 'sb_publishable_upstream' } }))

const host = { kind: 'desktop', build: { version: '0.1.0', commit: 'c4b5d1c1', sourceUrl: '' } } as never
const harbor = (over: Record<string, unknown> = {}) => ({ ...neutralEdition(), id: 'harbor', ...over }) as never

async function start(edition: never) {
  vi.resetModules()
  const reports = await import('../src/bugs/reports')
  const store = await import('../src/state/store')
  store.set({ crashReports: true, printerId: null })
  reports.resetBugReports()
  return { stop: reports.startBugReports(host, edition), reports }
}

const crash = () => window.dispatchEvent(new ErrorEvent('error', { error: new Error('Plate broke'), message: 'Plate broke' }))

describe('bugs.upstream', () => {
  let posts: { url: string; body: Record<string, string>; apikey: string; auth: string | null }[]
  beforeEach(() => {
    localStorage.clear()
    posts = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>
      posts.push({ url, body: JSON.parse(String(init.body)), apikey: h['apikey']!, auth: h['Authorization'] ?? null })
      return new Response('"00000000-0000-0000-0000-000000000001"', { status: 200 })
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('is off by default: a fork with no backend sends nothing anywhere', async () => {
    const { stop, reports } = await start(harbor())
    expect(reports.crashReportsOn()).toBe(false)
    crash()
    await new Promise((r) => setTimeout(r, 50))
    expect(posts).toEqual([])
    stop()
  })

  it('sends a crash report to SlicerX with the edition id, anonymously', async () => {
    const { stop } = await start(harbor({ bugs: { upstream: true } }))
    crash()
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]!.url).toBe('https://upstream.example/rest/v1/rpc/submit_bug_report')
    expect(posts[0]!.apikey).toBe('sb_publishable_upstream')
    expect(posts[0]!.auth).toBeNull()
    expect(posts[0]!.body).toMatchObject({ p_kind: 'crash', p_title: '[harbor] Error: Plate broke' })
    expect(posts[0]!.body['p_body']).toMatch(/^Edition: harbor\n/)
    stop()
  })

  it('also copies to SlicerX when the edition has its own backend, once, and a failed copy does not hold up its own', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)), apikey: '', auth: null })
      if (url.startsWith('https://upstream.example')) return new Response('{}', { status: 503 })
      return new Response('"id"', { status: 200 })
    })
    const own = { supabase: { url: 'https://own.example', anonKey: 'sb_publishable_ownownownownown' } }
    const { stop, reports } = await start(harbor({ bugs: { upstream: true }, backend: { ...neutralEdition().backend, ...own } }))
    crash()
    await vi.waitFor(() => expect(posts.filter((p) => p.url.startsWith('https://own.example'))).toHaveLength(1))
    expect(posts.filter((p) => p.url.startsWith('https://upstream.example'))).toHaveLength(1)
    // the own backend answered, so the report is off the queue and the failed copy is not retried
    await reports.sendQueued()
    expect(posts).toHaveLength(2)
    stop()
  })

  it('never copies a manual report', async () => {
    const own = { supabase: { url: 'https://own.example', anonKey: 'sb_publishable_ownownownownown' } }
    const { stop, reports } = await start(harbor({ bugs: { upstream: true }, backend: { ...neutralEdition().backend, ...own } }))
    const { finishReport } = await import('../src/bugs/report')
    await reports.sendManual(finishReport({ kind: 'manual', title: 'Odd seam', body: 'x', stack: null, logTail: null, appVersion: '1', commit: 'c', os: 'macOS', printer: null }))
    expect(posts.map((p) => new URL(p.url).host)).toEqual(['own.example'])
    stop()
  })
})
