// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkEditionConfig, crashReportsRequired, crashReportsSent, defineEditionConfig, DESKTOP_CONNECT_SRC, envLayer, geomFeatures, mergeLayers, NEUTRAL_EDITION, parseEditionConfig, tauriConfig, viteDefines, wellKnown } from '../src/index.ts'

const harbor = JSON.parse(readFileSync(new URL('../fixtures/fork-harbor.json', import.meta.url), 'utf8')) as unknown
const issues = (input: unknown) => {
  const r = checkEditionConfig(input)
  return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`)
}

describe('edition config', () => {
  it('accepts the neutral defaults and fills every default', () => {
    const c = defineEditionConfig({})
    expect(c.id).toBe('reference')
    expect(c.features.store).toBe(false)
    expect(c.features.printers.bambu).toBe(true)
    expect(c.backend.linkPort).toBe(47615)
  })

  it('has Set up local AI on by default, and an edition can turn it off or limit its models', () => {
    expect(defineEditionConfig({}).features.localAi).toBe(true)
    expect(defineEditionConfig({}).ai.allowedLocalModels).toBeUndefined()
    const c = defineEditionConfig({ features: { localAi: false }, ai: { allowedLocalModels: ['qwen-2.5-7b', 'qwen-2.5-14b'] } })
    expect(c.features.localAi).toBe(false)
    expect(c.ai.allowedLocalModels).toEqual(['qwen-2.5-7b', 'qwen-2.5-14b'])
    expect(issues(mergeLayers(NEUTRAL_EDITION, { ai: { allowedLocalModels: [] } }))).toHaveLength(1)
    expect(issues(mergeLayers(NEUTRAL_EDITION, { ai: { allowedLocalModels: ['Qwen 14B'] } }))[0]).toMatch(/allowedLocalModels/)
  })

  it('accepts the worked example fork', () => {
    expect(issues(harbor)).toEqual([])
    const c = defineEditionConfig({}, { extends: harbor as never })
    expect(c.features.printers.duet).toBe(false)
    expect(c.features.printers.bambu).toBe(true)
  })

  it('rejects features whose dependencies are off', () => {
    const out = issues(mergeLayers(NEUTRAL_EDITION, { features: { feed: true, creators: true, phonePairing: true } }))
    expect(out.join('\n')).toMatch(/feed needs store/)
    expect(out.join('\n')).toMatch(/creators needs store/)
    expect(out.join('\n')).toMatch(/phonePairing needs backend.relay/)
  })

  it('fills donations, moderation, routes and first run defaults', () => {
    const c = defineEditionConfig({})
    expect(c.library.moderation.mode).toBe('owner-approves-all')
    expect(c.library.moderation.allowedFormats).toEqual(['3mf', 'sx3mf', 'stl'])
    expect(c.routes.creator).toBe('/creators/:handle')
    expect(c.firstRun.defaultLook).toBe('slicerx')
    expect(c.funding).toEqual({})
    expect(c.downloads).toEqual({})
  })

  it('validates funding and download URLs', () => {
    expect(issues(mergeLayers(NEUTRAL_EDITION, { funding: { buyMeACoffee: 'https://buymeacoffee.com/x' }, downloads: { manifestUrl: 'https://x.example/downloads.json' } }))).toEqual([])
    expect(issues(mergeLayers(NEUTRAL_EDITION, { funding: { githubSponsors: 'not a url' } })).join()).toMatch(/funding/)
  })

  it('allows the store on demo data without a backend', () => {
    expect(issues(mergeLayers(NEUTRAL_EDITION, { features: { store: true, demoData: true }, legal: { sourceUrl: 'https://example.com/src/{commit}' } }))).toEqual([])
  })

  it('requires a source link for AGPL edition builds', () => {
    expect(issues(mergeLayers(NEUTRAL_EDITION, { features: { store: true, demoData: true } })).join()).toMatch(/sourceUrl/)
  })

  it('refuses the SlicerX name and identifiers in a fork', () => {
    const out = issues(mergeLayers(harbor, { brand: { name: 'SlicerX Harbor' }, apps: { desktop: { identifier: 'app.slicerx.desktop' } } })).join('\n')
    expect(out).toMatch(/trademark/)
    expect(out).toMatch(/app\.slicerx/)
  })

  it('refuses secrets', () => {
    const payload = btoa(JSON.stringify({ role: 'service_role' })).replace(/=+$/, '')
    const out = issues(mergeLayers(harbor, { backend: { supabase: { anonKey: `eyJhbGciOiJIUzI1NiJ9.${payload}.sig` } }, ai: { baseUrl: 'https://x.example/v1?key=sk-abcdefghijklmnopqrstuvwxyz' } })).join('\n')
    expect(out).toMatch(/service role/)
    expect(out).toMatch(/API key/)
  })

  it('refuses a Supabase secret key as the anon key, and takes a publishable one', () => {
    const secret = issues(mergeLayers(harbor, { backend: { supabase: { anonKey: 'sb_secret_0123456789abcdefghijklmnop' } } })).join('\n')
    expect(secret).toMatch(/Supabase secret key/)
    const publishable = issues(mergeLayers(harbor, { backend: { supabase: { anonKey: 'sb_publishable_0123456789abcdefghijklmnop' } } })).join('\n')
    expect(publishable).not.toMatch(/secret key/)
  })

  it('keeps the modeling tools by default, and leaves them out of the geometry engine when told to', () => {
    const on = parseEditionConfig(harbor)
    expect(on.features.cad).toBe(true)
    expect(geomFeatures(on)).toBeNull()
    const off = parseEditionConfig(mergeLayers(harbor, { features: { cad: false } }))
    expect(geomFeatures(off)).toEqual(['text', 'svg', 'nest', 'calib', 'hollow'])
  })

  it('applies environment overrides', () => {
    const layer = envLayer({ SLICERX_FEATURES: 'pilot,store', SLICERX_AI_MODEL: 'gpt-6-luna', SLICERX_RELAY_URL: 'https://relay.example' })
    expect(layer.features).toMatchObject({ store: true, pilot: true, feed: false })
    expect(layer.ai?.model).toBe('gpt-6-luna')
    expect(() => envLayer({ SLICERX_FEATURES: 'shop' })).toThrow(/unknown feature/)
  })

  it('reads sign-in providers and the Apple team id from the environment', () => {
    const layer = envLayer({ SLICERX_AUTH_PROVIDERS: 'email,github,apple', SLICERX_AUTH_GITHUB_CLIENT_ID: 'gh-123', SLICERX_AUTH_APPLE_CLIENT_ID: 'app.example.signin', SLICERX_APPLE_TEAM_ID: 'ABCDE12345' })
    expect(layer.auth?.providers).toEqual([{ kind: 'email' }, { kind: 'github', clientId: 'gh-123' }, { kind: 'apple', clientId: 'app.example.signin' }])
    expect(layer.apps?.ios?.teamId).toBe('ABCDE12345')
    expect(() => envLayer({ SLICERX_AUTH_PROVIDERS: 'email,google' })).toThrow(/SLICERX_AUTH_GOOGLE_CLIENT_ID/)
    expect(() => envLayer({ SLICERX_AUTH_PROVIDERS: 'myspace' })).toThrow(/unknown provider/)
    // a client id alone updates the file's providers
    const fromFile = envLayer({ SLICERX_AUTH_GOOGLE_CLIENT_ID: 'new-id' }, harbor as { auth: { providers: unknown[] } })
    expect(fromFile.auth?.providers).toEqual([{ kind: 'email' }, { kind: 'google', clientId: 'new-id' }])
  })

  it('produces build outputs', () => {
    const c = defineEditionConfig({}, { extends: harbor as never })
    const d = viteDefines(c)
    expect(d['__SX_FEATURE_STORE__']).toBe('true')
    expect(d['__SX_FEATURE_PILOT__']).toBe('true')
    expect(viteDefines(c, { SX_FEATURES: '' })['__SX_FEATURE_STORE__']).toBe('false')
    expect(tauriConfig(c, 'mobile')).toMatchObject({ identifier: 'com.harborprint.slice', productName: 'Harbor' })
    expect(Object.keys(wellKnown(c))).toEqual(['apple-app-site-association', 'assetlinks.json'])
  })

  it('lets the desktop page reach the backend and leaves the phone CSP alone', () => {
    const c = defineEditionConfig({}, { extends: harbor as never })
    expect(tauriConfig(c, 'desktop')).toMatchObject({ app: { security: { csp: { 'connect-src': `${DESKTOP_CONNECT_SRC} https://abcdefghijklmnop.supabase.co` } } } })
    expect(tauriConfig(c, 'mobile')).not.toHaveProperty('app')
    const bare = defineEditionConfig({ backend: { supabase: null }, features: { store: false, feed: false, creators: false } }, { extends: harbor as never })
    expect(tauriConfig(bare, 'desktop')).not.toHaveProperty('app.security')
  })

  it("keeps the desktop page's own connect-src, the printer bridge included, when the backend is added", () => {
    // tauriConfig replaces connect-src as a whole, so the base it builds on must be the desktop app's.
    const conf = JSON.parse(readFileSync(new URL('../../../apps/desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as { app: { security: { csp: Record<string, string> } } }
    expect(DESKTOP_CONNECT_SRC).toBe(conf.app.security.csp['connect-src'])
    expect(DESKTOP_CONNECT_SRC.split(' ')).toContain('ws://127.0.0.1:47615')
  })

  it('keeps upstream crash reports off unless the edition turns them on', () => {
    const c = defineEditionConfig({ backend: { supabase: null }, features: { store: false } }, { extends: harbor as never })
    expect(c.bugs.upstream).toBe(false)
    expect(crashReportsSent(c)).toBe(false)
    const on = defineEditionConfig({ backend: { supabase: null }, features: { store: false }, bugs: { upstream: true } }, { extends: harbor as never })
    expect(crashReportsSent(on)).toBe(true)
    expect(checkEditionConfig({ ...NEUTRAL_EDITION, bugs: { upstream: 'yes' } }).ok).toBe(false)
  })

  it('defaults to a stable release; pre-alpha requires crash reports', () => {
    const c = defineEditionConfig({}, { extends: harbor as never })
    expect(c.release.stage).toBe('stable')
    expect(crashReportsRequired(c)).toBe(false)
    const pre = defineEditionConfig({ release: { stage: 'pre-alpha', bugReportsUrl: 'https://example.com/bugs' } }, { extends: harbor as never })
    expect(crashReportsRequired(pre)).toBe(true)
    expect(checkEditionConfig({ ...NEUTRAL_EDITION, release: { stage: 'nightly' } }).ok).toBe(false)
  })

  it('turns the desktop updater on only for an edition with its own feed and key', () => {
    const pubkey = Buffer.from('untrusted comment: minisign public key: 1234ABCD\nRWQ' + 'A'.repeat(53) + '\n').toString('base64')
    const feed = 'https://updates.harbor.example/latest.json'
    expect(tauriConfig(defineEditionConfig({}, { extends: harbor as never }), 'desktop')).not.toHaveProperty('plugins.updater')
    const on = defineEditionConfig({ release: { updates: { endpoints: [feed], pubkey } } }, { extends: harbor as never })
    expect(tauriConfig(on, 'desktop')).toMatchObject({ plugins: { updater: { endpoints: [feed], pubkey, requireSignedVersion: true, windows: { installMode: 'passive' } } } })
    expect(tauriConfig(on, 'mobile')).not.toHaveProperty('plugins.updater')
    // plain http, an empty list or a key that is not one are refused
    const merged = (updates: unknown) => issues(mergeLayers(harbor as never, { release: { updates } } as never))
    expect(merged({ endpoints: ['http://updates.harbor.example/latest.json'], pubkey })).not.toHaveLength(0)
    expect(merged({ endpoints: [], pubkey })).not.toHaveLength(0)
    expect(merged({ endpoints: [feed], pubkey: 'not a key' })).not.toHaveLength(0)
    // a fork never takes SlicerX's feed, which would replace it with SlicerX
    expect(merged({ endpoints: ['https://github.com/slicerx-oss/slicerx/releases/download/desktop-updates/latest.json'], pubkey })[0]).toMatch(/own update feed/)
    expect(merged({ endpoints: ['https://slicerx.app/updates/latest.json'], pubkey })[0]).toMatch(/own update feed/)
    expect(merged({ endpoints: [feed], pubkey })).toEqual([])
  })
})

describe('runtime without a parser', () => {
  it('ships the neutral config pre-parsed, in step with the schema', async () => {
    const { neutralEdition, looksParsed, parseEditionConfig, NEUTRAL_EDITION } = await import('../src/index.ts')
    expect(neutralEdition()).toEqual(parseEditionConfig(NEUTRAL_EDITION))
    expect(looksParsed(neutralEdition())).toBe(true)
    expect(looksParsed({ id: 'x' })).toBe(false)
  })
})
