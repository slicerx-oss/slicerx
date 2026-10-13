// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cloud's daily use over the app link: read back as the app answers it, and a clear refusal without the app.
import { describe, expect, it, vi } from 'vitest'
import type { AppLinkCaller } from '../src/app-route'
import { mimirQuotaTools } from '../src/mimir-quota'

const QUOTA = { edition: 'slicerx', day: '2026-10-13', installUsed: 120_000, installCap: 500_000, ipUsed: 120_000, ipCap: 2_000_000, editionOpen: true }
const run = (link: AppLinkCaller | undefined) => mimirQuotaTools(link, 'SlicerX')[0]!.run({} as never, {} as never)

describe('mimir quota for MCP clients', () => {
  it("reads today's use through the app link, in dollars", async () => {
    const call = vi.fn(async () => QUOTA)
    const out = await run({ call: call as AppLinkCaller['call'] })
    expect(call).toHaveBeenCalledWith('mimir.quota', {})
    expect(out.summary).toBe('$0.38 of $0.50 free mimir use left today on this computer.')
    expect(out.output).toEqual({ day: '2026-10-13', edition: 'slicerx', open: true, install: { used_usd: 0.12, cap_usd: 0.5, left_usd: 0.38 }, network: { used_usd: 0.12, cap_usd: 2 }, resets: 'midnight, Australia/Melbourne' })
  })

  it('says when mimir cloud is closed for the day', async () => {
    const out = await run({ call: (async () => ({ ...QUOTA, editionOpen: false })) as AppLinkCaller['call'] })
    expect(out.summary).toMatch(/closed for today/)
  })

  it('refuses plainly without the app, or in a build with no mimir cloud', async () => {
    await expect(run(undefined)).rejects.toMatchObject({ code: 'not_configured' })
    const off = { call: (async () => { throw Object.assign(new Error('off'), { code: 'app_link_off' }) }) as AppLinkCaller['call'] }
    await expect(run(off)).rejects.toMatchObject({ code: 'not_configured' })
    const none = { call: (async () => { throw Object.assign(new Error('SlicerX has no mimir cloud in this build'), { code: 'not_found' }) }) as AppLinkCaller['call'] }
    await expect(run(none)).rejects.toMatchObject({ code: 'not_supported', message: 'SlicerX has no mimir cloud in this build' })
  })
})
