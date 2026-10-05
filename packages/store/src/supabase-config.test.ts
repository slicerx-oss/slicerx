// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NEUTRAL_EDITION, parseEditionConfig } from '@slicerx/edition-config'
import { loadEditionConfig } from '@slicerx/edition-config/node'
import { describe, expect, it } from 'vitest'
import { renderAuthProviders, renderAuthUrls, renderSupabaseConfig, replaceBlock } from './supabase-config'

let root = dirname(fileURLToPath(import.meta.url))
while (!existsSync(join(root, 'pnpm-workspace.yaml'))) root = dirname(root)

const fork = parseEditionConfig({
  ...NEUTRAL_EDITION,
  apps: { web: { origin: 'https://slice.example.com' }, desktop: { identifier: 'com.example.slice', productName: 'Example Slice' }, deepLinkScheme: 'exampleslice' },
  auth: { providers: [{ kind: 'email' }, { kind: 'google', clientId: 'public-google-client-id' }, { kind: 'discord', clientId: 'public-discord-id' }] },
})

describe('supabase config from the edition', () => {
  it('allows the web origin, the dev server and the deep link as redirects', () => {
    const text = renderAuthUrls(fork)
    expect(text).toContain('site_url = "https://slice.example.com"')
    for (const url of ['https://slice.example.com/auth/callback', 'http://127.0.0.1:5173/auth/callback', 'http://localhost:5173/auth/callback', 'exampleslice://auth/callback']) {
      expect(text).toContain(`"${url}"`)
    }
  })

  it('enables only configured OAuth providers, with public client ids and env secrets', () => {
    const text = renderAuthProviders(fork)
    expect(text).toMatch(/\[auth\.external\.google\]\nenabled = true\nclient_id = "public-google-client-id"/)
    expect(text).toMatch(/\[auth\.external\.discord\]\nenabled = true/)
    expect(text).toMatch(/\[auth\.external\.github\]\nenabled = false\nclient_id = ""/)
    expect(text).toContain('secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"')
  })

  it('replaces only the marked blocks and is idempotent', () => {
    const toml = 'a = 1\n# edition:auth-urls begin\nold\n# edition:auth-urls end\nb = 2\n# edition:auth-providers begin\n# edition:auth-providers end\nc = 3\n'
    const once = renderSupabaseConfig(toml, fork)
    expect(once.startsWith('a = 1\n')).toBe(true)
    expect(once).toContain('\nb = 2\n')
    expect(once.endsWith('c = 3\n')).toBe(true)
    expect(once).not.toContain('old')
    expect(renderSupabaseConfig(once, fork)).toBe(once)
    expect(() => replaceBlock('nothing here', 'auth-urls', 'x')).toThrow(/auth-urls/)
  })

  it('matches the committed supabase/config.toml for the SlicerX edition', async () => {
    const config = await loadEditionConfig({ cwd: root, env: {}, file: join(root, 'editions', 'slicerx', 'edition.config.ts') })
    const committed = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8')
    expect(renderSupabaseConfig(committed, config)).toBe(committed)
  })
})
