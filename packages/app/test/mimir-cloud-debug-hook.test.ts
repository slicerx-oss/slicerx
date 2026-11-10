// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The test hook in pilot-connect/cloud.ts: with localStorage 'slicerx.debug' set when the module loads, a page script can
// stand in for mimir cloud (window.__sxMimirCloud). End-to-end journeys rely on it (apps/web/e2e/journeys/lib/session.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Hook = (h: unknown, base: string) => void
const win = (): { __sxMimirCloud?: Hook } => window as unknown as { __sxMimirCloud?: Hook }

describe('the mimir cloud test hook', () => {
  beforeEach(() => {
    vi.resetModules()
    delete win().__sxMimirCloud
  })
  afterEach(() => {
    localStorage.removeItem('slicerx.debug')
    delete win().__sxMimirCloud
  })

  it('is installed when slicerx.debug is set, and registers the host it is given', async () => {
    localStorage.setItem('slicerx.debug', '1')
    const cloud = await import('../src/pilot-connect/cloud')
    expect(typeof win().__sxMimirCloud).toBe('function')
    const host = { quota: async () => ({}) as never, forget: async () => 0, register: async () => undefined }
    win().__sxMimirCloud?.(host, 'http://127.0.0.1:9/functions/v1/mimir')
    expect(cloud.mimirCloudHost()).toBe(host)
    expect(cloud.cloudTestBase()).toBe('http://127.0.0.1:9/functions/v1/mimir')
  })

  it('is absent when slicerx.debug is not set', async () => {
    await import('../src/pilot-connect/cloud')
    expect(win().__sxMimirCloud).toBeUndefined()
  })
})
