// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The release check that refuses a demo build: the SlicerX edition resolved with and without its backend variables,
// the built frontend's demoData flag, and the release scripts that run it before anything is signed.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error a plain .mjs release script, no types
import { BACKEND_VARS, check, demoFlags, resolveEdition } from '../release/check-demo-data.mjs'

const repo = resolve(import.meta.dirname, '../../..')
const dir = () => mkdtempSync(join(tmpdir(), 'sx-demo-check-'))
// Placeholders shaped like a project URL and a publishable key; nothing is called.
const BACKEND = { SLICERX_SUPABASE_URL: 'https://example-project.supabase.co', SLICERX_SUPABASE_ANON_KEY: 'sb_publishable_placeholder_key_0123456789' }
const plain = (extra: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, ...extra }
  for (const v of [...BACKEND_VARS, 'SLICERX_CONFIG']) if (!(v in extra)) delete env[v]
  return env
}
const frontend = (runtime: string) => {
  const d = dir()
  mkdirSync(join(d, 'static'))
  writeFileSync(join(d, 'index.html'), '<script type="module" src="./static/index.js"></script>')
  writeFileSync(join(d, 'static', 'index.js'), 'console.log("app")')
  writeFileSync(join(d, 'static', 'runtime-x1.js'), runtime)
  return d
}

describe('demo build release check', () => {
  it('reads the flag minified and as JSON', () => {
    expect(demoFlags('features:{store:!0,demoData:!1,cloudSlicing:!1}')).toEqual({ on: 0, off: 1 })
    expect(demoFlags('{"demoData":true,"x":1} demoData:!0')).toEqual({ on: 2, off: 0 })
    expect(demoFlags('const notDemoDataHere = 1')).toEqual({ on: 0, off: 0 })
  })

  it('passes a frontend built with its backend and fails a demo one', () => {
    expect(check({ dists: [frontend('e={id:"slicerx",features:{demoData:!1}}')] }).problems).toEqual([])
    const r = check({ dists: [frontend('e={id:"slicerx",features:{demoData:!0}}')] })
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain('runtime-x1.js')
    expect(r.problems[0]).toContain('demo build')
  })

  it('fails a frontend that carries no flag, since it proves nothing', () => {
    const r = check({ dists: [frontend('console.log("no edition here")')] })
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain('cannot be checked')
  })

  it('passes the SlicerX edition with both backend variables and fails it without them', () => {
    const withBackend = plain(BACKEND)
    const ok = check({ env: withBackend, edition: resolveEdition(withBackend) })
    expect(ok.problems).toEqual([])
    expect(ok.passed).toEqual(['the slicerx edition resolves with demoData off'])

    const without = plain()
    const bad = check({ env: without, edition: resolveEdition(without) })
    expect(bad.problems).toEqual(['the slicerx edition resolves with demoData on: this would be a demo build (SLICERX_SUPABASE_URL and SLICERX_SUPABASE_ANON_KEY not set)'])

    // One of the two is not enough: the backend without its key does not even resolve, so the check fails.
    expect(() => resolveEdition(plain({ SLICERX_SUPABASE_URL: BACKEND.SLICERX_SUPABASE_URL }))).toThrow(/anonKey/)
    // Never prints a value.
    expect(JSON.stringify([ok, bad])).not.toContain(BACKEND.SLICERX_SUPABASE_ANON_KEY)
  })

  it('says so when the edition config does not resolve', () => {
    expect(() => resolveEdition(plain({ SLICERX_CONFIG: join(dir(), 'missing.config.ts') }))).toThrow(/did not resolve/)
  })

  it('runs in every desktop release path: before the build and on the frontend before signing', () => {
    const mac = readFileSync(join(repo, 'apps/desktop/release/macos-sign.sh'), 'utf8')
    expect(mac.indexOf('check-demo-data.mjs --env')).toBeGreaterThan(0)
    expect(mac.indexOf('check-demo-data.mjs --env')).toBeLessThan(mac.indexOf('pnpm tauri build'))
    expect(mac.indexOf('check-demo-data.mjs --dist apps/desktop/dist')).toBeGreaterThan(mac.indexOf('pnpm tauri build'))
    expect(mac.indexOf('check-demo-data.mjs --dist apps/desktop/dist')).toBeLessThan(mac.indexOf('"${signer[@]}" "$app"'))

    const ps = readFileSync(join(repo, 'apps/desktop/release/windows-sign.ps1'), 'utf8')
    const release = ps.slice(ps.indexOf('if ($Release)'), ps.indexOf('if ($VerifyInstalled)'))
    expect(release.indexOf('check-demo-data.mjs --env')).toBeGreaterThan(0)
    expect(release.indexOf('check-demo-data.mjs --env')).toBeLessThan(release.indexOf('pnpm tauri build'))
    expect(release.indexOf('check-demo-data.mjs --dist apps/desktop/dist')).toBeGreaterThan(release.indexOf('pnpm tauri build'))
    expect(release.indexOf('check-demo-data.mjs --dist apps/desktop/dist')).toBeLessThan(release.indexOf('Copy-Item'))

    const wf = readFileSync(join(repo, '.github/workflows/desktop-release.yml'), 'utf8')
    expect(wf.indexOf('check-demo-data.mjs --env')).toBeGreaterThan(0)
    expect(wf.indexOf('check-demo-data.mjs --env')).toBeLessThan(wf.indexOf('tauri-apps/tauri-action'))
    expect(wf.indexOf('check-demo-data.mjs --dist apps/desktop/dist')).toBeGreaterThan(wf.indexOf('tauri-apps/tauri-action'))
    for (const v of BACKEND_VARS) expect(wf).toContain(`${v}: \${{ vars.${v} }}`)
  })
})
