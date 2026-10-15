// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The operation preview tool forwards to the open app, reads the preview back as a client would, and says how to
// reach the app while its link is off.
import { describe, expect, it, vi } from 'vitest'
import { appModelOpPreviewTools, type AppOpPreview } from '../src/app-model-op-preview'
import type { AppLinkCaller } from '../src/app-route'
import { ToolInputError } from '../src/errors'

const shut: AppOpPreview = { open: false, tool: null, status: 'none', message: null, showingLastGood: false, adds: false, removes: false }

describe('app model operation preview tool', () => {
  it('reads the open tool: ok, an error with the last good preview kept, and nothing open', async () => {
    let now: AppOpPreview = { open: true, tool: 'push', status: 'ok', message: null, showingLastGood: false, adds: false, removes: true }
    const call = vi.fn(async () => now)
    const [read] = appModelOpPreviewTools({ call } as unknown as AppLinkCaller, 'SlicerX')
    expect(read!.name).toBe('app.model_op_preview')
    expect(read!.permission).toBe('read')
    const ok = await read!.run({} as never, {} as never)
    expect(call).toHaveBeenLastCalledWith('model.op_preview', {})
    expect(ok.summary).toBe('Push and pull: the preview removes material.')
    now = { ...now, tool: 'fillet', status: 'error', message: 'The radius is too big for this edge. Showing the last good preview.', showingLastGood: true, adds: false, removes: true }
    const bad = await read!.run({} as never, {} as never)
    expect(bad.output).toMatchObject({ status: 'error', showingLastGood: true })
    expect(bad.summary).toBe('Fillet: The radius is too big for this edge. Showing the last good preview.')
    now = shut
    expect((await read!.run({} as never, {} as never)).summary).toBe('No Model tool with a preview is open.')
  })

  it('says how to reach the app while the link is off or missing', async () => {
    const [none] = appModelOpPreviewTools(undefined, 'SlicerX')
    expect(((await none!.run({} as never, {} as never).catch((x: unknown) => x)) as ToolInputError).code).toBe('not_configured')
    for (const code of ['app_link_off', 'app_closed', 'forbidden']) {
      const call = async () => {
        throw Object.assign(new Error(code), { code })
      }
      const [read] = appModelOpPreviewTools({ call } as unknown as AppLinkCaller, 'SlicerX')
      const e = (await read!.run({} as never, {} as never).catch((x: unknown) => x)) as ToolInputError
      expect(e.code, code).toBe('not_configured')
      expect(e.message, code).toMatch(/SlicerX is closed/)
    }
  })
})
