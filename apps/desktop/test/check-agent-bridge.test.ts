// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The release check that proves a build has no agent bridge: binary and frontend markers, the Cargo feature set, and
// the build environment. The real Cargo.toml must pass it.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error a plain .mjs release script, no types
import { cargoFeatures, check, defaultEnables, markersIn, PAGE_MARKERS, SHELL_MARKERS } from '../release/check-agent-bridge.mjs'

const dir = () => mkdtempSync(join(tmpdir(), 'sx-bridge-check-'))

describe('agent bridge release check', () => {
  it('finds the shell markers anywhere in a binary', () => {
    const bin = Buffer.concat([Buffer.alloc(4096, 0), Buffer.from('xxSX_AGENT_BRIDGE_PORTyy'), Buffer.alloc(16, 0xff)])
    expect(markersIn(bin, SHELL_MARKERS)).toEqual(['SX_AGENT_BRIDGE_PORT'])
    expect(markersIn(Buffer.from('a plain release binary'), SHELL_MARKERS)).toEqual([])
  })

  it('fails a bridge binary and passes a clean one', () => {
    const d = dir()
    const clean = join(d, 'slicerx.exe')
    const bridged = join(d, 'slicerx-bridge.exe')
    writeFileSync(clean, Buffer.from('MZ... tauri app ... sx-probe'))
    writeFileSync(bridged, Buffer.from('MZ... agent_bridge_reply ... sx-agent-bridge'))
    expect(check({ binaries: [clean] }).problems).toEqual([])
    const r = check({ binaries: [clean, bridged] })
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain('slicerx-bridge.exe')
    expect(r.problems[0]).toContain('agent_bridge_reply')
  })

  it('scans every script and page of a frontend build', () => {
    const d = dir()
    mkdirSync(join(d, 'static'))
    writeFileSync(join(d, 'index.html'), '<script type="module" src="./static/index.js"></script>')
    writeFileSync(join(d, 'static', 'index.js'), 'console.log("app")')
    writeFileSync(join(d, 'static', 'logo.png'), 'agent_bridge_ready')
    expect(check({ dists: [d] }).problems).toEqual([])
    writeFileSync(join(d, 'static', 'agent-bridge-x1.js'), 'invoke("agent_bridge_ready")')
    const r = check({ dists: [d] })
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain('agent-bridge-x1.js')
    expect(PAGE_MARKERS).toContain('agent_bridge_ready')
  })

  it('reads the features table and follows features into features', () => {
    const toml = ['[package]', 'name = "x"', '', '[features]', 'default = ["store", "connect"] # the full app', 'store = []', 'connect = ["dep:tokio", "devtools"]', 'devtools = []', 'agent-bridge = ["dep:getrandom"]', '', '[dependencies]', 'tokio = "1"'].join('\n')
    const f = cargoFeatures(toml)
    expect(f.default).toEqual(['store', 'connect'])
    expect(f['agent-bridge']).toEqual(['dep:getrandom'])
    expect(defaultEnables(f)).toBe(false)
    expect(defaultEnables({ ...f, devtools: ['agent-bridge'] })).toBe(true)
    expect(defaultEnables({ ...f, default: ['agent-bridge'] })).toBe(true)
    expect(defaultEnables({ default: ['a'], a: ['b'], b: ['a'] })).toBe(false)
  })

  it('passes the real desktop crate, whose default features leave the bridge out', () => {
    const manifest = resolve(import.meta.dirname, '../src-tauri/Cargo.toml')
    const r = check({ manifest })
    expect(r.problems).toEqual([])
    expect(cargoFeatures(readFileSync(manifest, 'utf8'))['agent-bridge']).toBeDefined()
  })

  it('runs before every signature: windows-sign.ps1 for each file it signs, sign-mac with the same names as a fallback', () => {
    const repo = resolve(import.meta.dirname, '../../..')
    const ps = readFileSync(join(repo, 'apps/desktop/release/windows-sign.ps1'), 'utf8')
    const signOne = ps.slice(ps.indexOf('function Sign-One'), ps.indexOf('function Hash-Into'))
    expect(signOne.indexOf('Check-NoBridge $path')).toBeGreaterThan(0)
    expect(signOne.indexOf('Check-NoBridge $path')).toBeLessThan(signOne.indexOf('sign /v'))
    expect(ps).toMatch(/check-agent-bridge\.mjs'\s*\n\s*& node \$check --binary \$path/)
    const mac = readFileSync(join(repo, 'scripts/sign-mac'), 'utf8')
    const listed = /^bridge_markers=\(([^)]*)\)$/m.exec(mac)?.[1]?.split(/\s+/)
    expect(listed).toEqual(SHELL_MARKERS)
    for (const kind of ['app', 'bin']) {
      const start = mac.indexOf(`\n  ${kind})`)
      const arm = mac.slice(start, mac.indexOf(';;', start))
      expect(start, kind).toBeGreaterThan(0)
      expect(arm.indexOf('no_bridge'), kind).toBeGreaterThan(0)
      expect(arm.indexOf('no_bridge'), kind).toBeLessThan(arm.indexOf('sign_file'))
    }
  })

  it('refuses an environment that makes a bridge build', () => {
    expect(check({ env: { SLICERX_AGENT_BRIDGE: '1' } }).problems).toHaveLength(1)
    expect(check({ env: {} }).problems).toEqual([])
  })
})
