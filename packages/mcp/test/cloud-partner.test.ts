// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Cloud slicing with a partner app token, against a fake cloud service over real HTTP.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloudFromEnv } from '../src/cloud'
import { startFakeCloud, FAKE_GCODE, type FakeCloudServer } from './fake-cloud-server'
import { connect, data, text } from './helpers'

const PERSON = 'person-1'
// Made-up tokens for the fake service; no real service ever sees them.
const OWN = `sxk_${'a'.repeat(64)}`
const PHONE = `sxk_${'b'.repeat(64)}`
const OTHER_APP = `sxk_${'c'.repeat(64)}`
const LINK_ONLY = `sxk_${'d'.repeat(64)}`

let svc: FakeCloudServer
beforeEach(async () => {
  svc = await startFakeCloud()
  svc.tokens.set(OWN, { user: PERSON, scopes: ['cloud_slice', 'cli'] })
  svc.tokens.set(PHONE, { user: PERSON, scopes: ['cloud_slice'], partnerApp: 'Example Phone' })
  svc.tokens.set(OTHER_APP, { user: PERSON, scopes: ['cloud_slice'], partnerApp: 'Other App' })
  svc.tokens.set(LINK_ONLY, { user: PERSON, scopes: ['link'] })
  svc.limits.set(PERSON, 4)
})
afterEach(async () => {
  await svc.close()
})

/** The MCP server set up as a partner app runs it: the API and the token from the environment. */
const asPartner = (token: string) => connect({ cloud: cloudFromEnv({ SLICERX_MCP_CLOUD_API: svc.url, SLICERX_MCP_CLOUD_TOKEN: token }) })

describe('cloud slicing with a partner app token', () => {
  it('reads back which app the token is for and the account limits it shares', async () => {
    const h = await asPartner(PHONE)
    const r = await h.call('slicerx_cloud_access', {})
    expect(r.isError, text(r)).toBeFalsy()
    expect(data<{ output: Record<string, unknown> }>(r).output).toEqual({
      invited: true,
      slicesPerDay: 4,
      slicesToday: 0,
      slicesLeft: 4,
      maxUploadBytes: 25 * 1_048_576,
      maxUpload: '25 MB',
      partnerApp: 'Example Phone',
      jobsVisible: 'own',
      canSendToPrinter: false,
    })
    const own = data<{ output: Record<string, unknown> }>(await (await asPartner(OWN)).call('slicerx_cloud_access', {})).output
    expect(own['partnerApp']).toBeUndefined()
    expect(own['jobsVisible']).toBe('account')
  })

  it('slices on the account, lists only its own jobs, and downloads with the token in the header only', async () => {
    const mine = await asPartner(OWN)
    expect((await mine.call('slicerx_cloud_slice', { model: join(mine.dir, 'cube.stl'), name: 'Desk job' })).isError).toBeFalsy()
    const h = await asPartner(PHONE)
    const r = await h.call('slicerx_cloud_slice', { model: join(h.dir, 'cube.stl'), name: 'Phone job' })
    expect(r.isError, text(r)).toBeFalsy()
    const jobId = data<{ output: { jobId: string } }>(r).output.jobId
    expect(svc.jobs.find((j) => j.id === jobId)?.token).toBe(PHONE)

    const list = data<{ output: { jobs: { name: string }[] } }>(await h.call('slicerx_cloud_jobs', {})).output
    expect(list.jobs.map((j) => j.name)).toEqual(['Phone job'])
    const everything = data<{ output: { jobs: { name: string }[] } }>(await mine.call('slicerx_cloud_jobs', {})).output
    expect(everything.jobs.map((j) => j.name)).toEqual(['Phone job', 'Desk job'])

    const desk = svc.jobs.find((j) => j.name === 'Desk job')!
    const hidden = await h.call('slicerx_cloud_jobs', { job_id: desk.id })
    expect(hidden.isError).toBe(true)

    const got = data<{ output: { status: string; links: { gcode: string } } }>(await h.call('slicerx_cloud_jobs', { job_id: jobId })).output
    expect(got.status).toBe('succeeded')
    const res = await fetch(got.links.gcode, { headers: { authorization: `Bearer ${PHONE}` } })
    expect(await res.text()).toBe(FAKE_GCODE)

    expect(svc.requests.length).toBeGreaterThan(5)
    for (const q of svc.requests) expect(q.url, 'no token in a URL').not.toMatch(/sxk_/)
    expect(svc.requests.filter((q) => q.auth === `Bearer ${PHONE}`).length).toBeGreaterThan(0)
  })

  it('shares the account daily limit with the person and their other apps', async () => {
    svc.limits.set(PERSON, 2)
    const mine = await asPartner(OWN)
    await mine.call('slicerx_cloud_slice', { model: 'sample:cube-20' })
    const other = await asPartner(OTHER_APP)
    await other.call('slicerx_cloud_slice', { model: 'sample:cube-20' })
    const h = await asPartner(PHONE)
    const r = await h.call('slicerx_cloud_slice', { model: 'sample:cube-20' })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/used all 2 cloud jobs of the last 24 hours/)
    expect(data<{ output: { slicesLeft: number } }>(await h.call('slicerx_cloud_access', {})).output.slicesLeft).toBe(0)
  })

  it('stops at once when the person revokes the token, and says what to do', async () => {
    const h = await asPartner(PHONE)
    expect((await h.call('slicerx_cloud_access', {})).isError).toBeFalsy()
    svc.tokens.get(PHONE)!.revoked = true
    const before = svc.jobs.length
    for (const [tool, args] of [
      ['slicerx_cloud_access', {}],
      ['slicerx_cloud_jobs', {}],
      ['slicerx_cloud_slice', { model: 'sample:cube-20' }],
    ] as const) {
      const r = await h.call(tool, args)
      expect(r.isError, tool).toBe(true)
      expect(text(r)).toMatch(/unknown, expired or revoked/)
      expect(text(r)).toMatch(/Partner apps/)
    }
    expect(svc.jobs.length).toBe(before)
    expect((await (await asPartner(OTHER_APP)).call('slicerx_cloud_access', {})).isError).toBeFalsy()
  })

  it('refuses a token without the cloud_slice scope', async () => {
    const r = await (await asPartner(LINK_ONLY)).call('slicerx_cloud_access', {})
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/cloud_slice scope/)
  })

  it('answers that cloud slicing is not configured without a cloud API', async () => {
    const r = await (await connect()).call('slicerx_cloud_access', {})
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/Cloud slicing is not configured/)
  })
})
