// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The SlicerX edition with a backend runs mimir on mimir cloud and asks it for Sonnet on every turn (owner, at launch);
// without a backend there is no mimir cloud and nothing to ask.
import { afterEach, describe, expect, it, vi } from 'vitest'

const BACKEND = { SLICERX_SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co', SLICERX_SUPABASE_ANON_KEY: 'sb_publishable_placeholder_key_0123456789' }

/** The edition file as a build reads it: its environment is read when the file loads. */
async function slicerx(env: Record<string, string>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return (await import('../../../editions/slicerx/edition.config.ts')).default
}

afterEach(() => vi.unstubAllEnvs())

describe('the slicerx edition and mimir cloud', () => {
  it('asks for Sonnet on every turn with a backend', async () => {
    const edition = await slicerx(BACKEND)
    expect(edition.ai.keySource).toBe('cloud')
    expect(edition.ai.brain.cloud).toEqual({ stepUp: 'sonnet', everyTurn: 'step' })
  })

  it('has no step-up to ask for without one', async () => {
    const edition = await slicerx({ SLICERX_SUPABASE_URL: '', SLICERX_SUPABASE_ANON_KEY: '' })
    expect(edition.ai.keySource).toBe('keychain')
    expect(edition.ai.brain.cloud).toEqual({ stepUp: 'none', everyTurn: 'auto' })
  })
})
