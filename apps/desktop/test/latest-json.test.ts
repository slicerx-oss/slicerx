// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// latest.json, the update manifest publish.sh writes: one entry per updater target, signatures checked against the
// edition's key, file and version, and the release's top five highlights kept short.
import { describe, expect, it } from 'vitest'
// @ts-expect-error a plain .mjs release script, no types
import { keyId, latestJson, shorten, signedFields, topNotes } from '../release/latest-json.mjs'

// minisign texts as `tauri signer` writes them, base64 once more; only the key ids and the trusted comment matter here
const b64 = (s: string) => Buffer.from(s).toString('base64')
const keyLine = (id: number, rest: number) => Buffer.concat([Buffer.from('Ed'), Buffer.alloc(8, id), Buffer.alloc(rest, 7)]).toString('base64')
const pubkey = (id = 1) => b64(`untrusted comment: minisign public key: ${id}\n${keyLine(id, 32)}\n`)
const sig = (file: string, version: string | null, id = 1) =>
  b64(`untrusted comment: signature from tauri secret key\n${keyLine(id, 64)}\ntrusted comment: timestamp:1791266400\tfile:${file}${version ? `\tversion:${version}` : ''}\n${Buffer.alloc(64, 3).toString('base64')}\n`)

const V = '0.2.0'
const base = 'https://github.com/slicerx-oss/slicerx/releases/download/desktop-v0.2.0'
const release = 'https://github.com/slicerx-oss/slicerx/releases/tag/desktop-v0.2.0'
const names = ['SlicerX_0.2.0_universal.app.tar.gz', 'SlicerX_0.2.0_x64-setup.exe', 'SlicerX_0.2.0_x64_en-US.msi', 'SlicerX_0.2.0_amd64.AppImage']
const signed = () => Object.fromEntries(names.map((n) => [n, sig(n, V)]))
const write = (files: Record<string, string | null>, over: Record<string, unknown> = {}) => latestJson({ version: V, files, baseUrl: base, releaseUrl: release, pubkey: pubkey(), date: new Date('2026-10-06T03:00:00Z'), ...over })

describe('latest.json', () => {
  it('maps each bundle to its updater targets with its signature, version, date and release page', () => {
    const m = write({ ...signed(), 'SlicerX_0.2.0_amd64.deb': null, 'SHA256SUMS.txt': null }, { notes: ['One', 'Two'] })
    expect(Object.keys(m.platforms).sort()).toEqual(['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64', 'windows-x86_64-msi'])
    expect(m.platforms['darwin-aarch64']).toEqual({ url: `${base}/SlicerX_0.2.0_universal.app.tar.gz`, signature: sig(names[0]!, V) })
    expect(m.platforms['darwin-x86_64'].url).toBe(m.platforms['darwin-aarch64'].url)
    // an MSI install never gets the NSIS setup
    expect(m.platforms['windows-x86_64'].url).toMatch(/-setup\.exe$/)
    expect(m.platforms['windows-x86_64-msi'].url).toMatch(/\.msi$/)
    expect(m.platforms['linux-x86_64'].url).toMatch(/\.AppImage$/)
    expect(m).toMatchObject({ version: V, notes: 'One\nTwo', pub_date: '2026-10-06T03:00:00.000Z', release_url: release, deb_url: `${base}/SlicerX_0.2.0_amd64.deb` })
  })

  it('leaves out a platform the release has no bundle for', () => {
    const m = write({ [names[0]!]: sig(names[0]!, V) })
    expect(Object.keys(m.platforms)).toEqual(['darwin-aarch64', 'darwin-x86_64'])
    expect(m).not.toHaveProperty('deb_url')
  })

  it('refuses a bundle without a signature, or signed with another key, for another file or another version', () => {
    expect(() => write({ ...signed(), [names[1]!]: null })).toThrow(/has no \.sig/)
    expect(() => write({ ...signed(), [names[1]!]: sig(names[1]!, V, 9) })).toThrow(/another key/)
    expect(() => write({ ...signed(), [names[1]!]: sig(names[2]!, V) })).toThrow(/signs SlicerX_0\.2\.0_x64_en-US\.msi/)
    expect(() => write({ ...signed(), [names[1]!]: sig(names[1]!, '0.1.9') })).toThrow(/version 0\.1\.9/)
    // a signature made without --app-version would fail requireSignedVersion in the app
    expect(() => write({ ...signed(), [names[1]!]: sig(names[1]!, null) })).toThrow(/version \(none\)/)
    expect(() => write({ 'SlicerX_0.2.0_amd64.deb': null })).toThrow(/no update bundles/)
  })

  it('reads the key id and the signed fields the way the updater does', () => {
    expect(keyId(pubkey(5))).toBe('0505050505050505')
    expect(keyId(sig('a', V, 5))).toBe('0505050505050505')
    expect(signedFields(sig('SlicerX.app.tar.gz', V))).toEqual({ timestamp: '1791266400', file: 'SlicerX.app.tar.gz', version: V })
    expect(() => keyId(b64('nothing here'))).toThrow(/not a minisign/)
  })
})

describe('release highlights', () => {
  it('takes the first five notes from whats-changed.json, kept short', () => {
    const long = 'The Print sheet now shows the filament each slot will use, the bed state the printer reported and the plate'
    const json = { notes: ['A', 'B', long, 'D', 'E', 'F'].map((note) => ({ note, ref: 'abc1234' })) }
    const out = topNotes(json)
    expect(out).toHaveLength(5)
    expect(out[2]!.length).toBeLessThanOrEqual(100)
    expect(out[2]!.endsWith('…')).toBe(true)
    expect(out[2]).toBe(shorten(long))
    expect(topNotes({ notes: [] })).toEqual([])
  })

  it("reads a hand-written changed.md: list items only, no heading or the urgent line", () => {
    const md = '**Please update.** A crash on open.\n\n## What changed\n\n- One thing\n- Another   thing\n* A third\n'
    expect(topNotes(md)).toEqual(['One thing', 'Another thing', 'A third'])
  })
})
