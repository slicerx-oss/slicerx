// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES, slugify, validateCreatorLink, validateCreatorLinks, validateDevice, validateHandle, validateUpload } from './validate'

const bad = (r: { ok: boolean }) => expect(r.ok).toBe(false)

describe('validateCreatorLink', () => {
  it('accepts https links and trims them', () => {
    expect(validateCreatorLink({ kind: 'website', url: '  https://ferro.example.com/about?x=1#top  ', label: ' Site ' })).toEqual({
      ok: true,
      value: { kind: 'website', url: 'https://ferro.example.com/about?x=1#top', label: 'Site' },
    })
    expect(validateCreatorLink({ kind: 'other', url: 'HTTPS://Example.COM:8443/a' })).toMatchObject({ ok: true })
    expect(validateCreatorLink({ kind: 'website', url: 'https://example.com', label: '   ' })).toEqual({ ok: true, value: { kind: 'website', url: 'https://example.com' } })
  })

  it('refuses anything but https', () => {
    for (const url of ['http://example.com', 'ftp://example.com', 'javascript:alert(1)', '//example.com', 'example.com', 'https:example.com', '']) {
      bad(validateCreatorLink({ kind: 'website', url }))
    }
  })

  it('refuses malformed hosts, spaces and injection characters', () => {
    for (const url of [
      'https://localhost',
      'https://exa mple.com',
      'https://example',
      'https://-bad.example.com',
      'https://user@example.com',
      'https://example.com/a b',
      'https://example.com/<x>',
      'https://example.com/"x"',
      "https://example.com/'x'",
      'https://example.com/back\\slash',
      'https://example.com:99999999',
      `https://example.com/${'a'.repeat(300)}`,
    ]) {
      bad(validateCreatorLink({ kind: 'website', url }))
    }
  })

  it('holds a named service to its own domain', () => {
    expect(validateCreatorLink({ kind: 'patreon', url: 'https://www.patreon.com/someone' })).toMatchObject({ ok: true })
    expect(validateCreatorLink({ kind: 'patreon', url: 'https://sub.patreon.com/someone' })).toMatchObject({ ok: true })
    expect(validateCreatorLink({ kind: 'youtube', url: 'https://youtu.be/abc' })).toMatchObject({ ok: true })
    expect(validateCreatorLink({ kind: 'x', url: 'https://twitter.com/someone' })).toMatchObject({ ok: true })
    expect(validateCreatorLink({ kind: 'discord', url: 'https://discord.gg/abc' })).toMatchObject({ ok: true })
    expect(validateCreatorLink({ kind: 'kofi', url: 'https://ko-fi.com/someone' })).toMatchObject({ ok: true })
    for (const [kind, url] of [
      ['patreon', 'https://example.com/patreon.com'],
      ['patreon', 'https://notpatreon.com/x'],
      ['patreon', 'https://patreon.com.evil.example/x'],
      ['github', 'https://gitlab.com/x'],
      ['youtube', 'https://youtube.org/x'],
    ] as const) {
      bad(validateCreatorLink({ kind, url }))
    }
    expect(validateCreatorLink({ kind: 'patreon', url: 'https://example.com/x' })).toMatchObject({ ok: false, message: 'A patreon link must point to patreon.com' })
  })

  it('checks the label length and the kind', () => {
    bad(validateCreatorLink({ kind: 'website', url: 'https://example.com', label: 'x'.repeat(61) }))
    expect(validateCreatorLink({ kind: 'website', url: 'https://example.com', label: 'x'.repeat(60) })).toMatchObject({ ok: true })
    bad(validateCreatorLink({ kind: 'myspace' as never, url: 'https://example.com' }))
  })
})

describe('validateCreatorLinks', () => {
  it('allows 12 and refuses 13, and refuses a repeated address', () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'website' as const, url: `https://site${i}.example.com` }))
    expect(validateCreatorLinks(make(12)).ok).toBe(true)
    expect(validateCreatorLinks(make(13))).toMatchObject({ ok: false, message: 'A creator page has at most 12 links' })
    expect(validateCreatorLinks([{ kind: 'website', url: 'https://a.example.com' }, { kind: 'other', url: 'https://a.example.com' }])).toMatchObject({ ok: false })
    expect(validateCreatorLinks([{ kind: 'website', url: 'https://ok.example.com' }, { kind: 'patreon', url: 'https://example.com' }])).toMatchObject({ ok: false, message: expect.stringContaining('Link 2') })
    expect(validateCreatorLinks([])).toEqual({ ok: true, value: [] })
  })
})

describe('validateUpload', () => {
  const ok = { name: 'model.3mf', version: '1.0.0', format: '3mf' as const, size: 1000 }
  it('accepts the three formats', () => {
    expect(validateUpload(ok).ok).toBe(true)
    expect(validateUpload({ ...ok, name: 'a.sx3mf', format: 'sx3mf' }).ok).toBe(true)
    expect(validateUpload({ ...ok, name: 'a.stl', format: 'stl' }).ok).toBe(true)
    expect(validateUpload({ ...ok, size: MAX_UPLOAD_BYTES }).ok).toBe(true)
    expect(validateUpload({ ...ok, size: 1 }).ok).toBe(true)
  })
  it('refuses bad names, sizes and versions', () => {
    for (const name of ['Model.3mf', 'model.obj', 'model', '.3mf', 'a/b.3mf', 'a\\b.3mf', `${'a'.repeat(200)}.3mf`, 'model.3mf.exe']) bad(validateUpload({ ...ok, name }))
    bad(validateUpload({ ...ok, name: 'a.stl' }))
    bad(validateUpload({ ...ok, size: 0 }))
    bad(validateUpload({ ...ok, size: MAX_UPLOAD_BYTES + 1 }))
    for (const version of ['1', '1.0', 'v1.0.0', '1.0.0-beta', '']) bad(validateUpload({ ...ok, version }))
  })
})

describe('validateUpload with library settings', () => {
  const ok = { name: 'model.3mf', version: '1.0.0', format: '3mf' as const, size: 200 * 1_048_576 }
  it('reads the size limit and formats from the settings', () => {
    bad(validateUpload(ok))
    expect(validateUpload(ok, { maxFileMb: 250 }).ok).toBe(true)
    expect(validateUpload({ ...ok, size: 10 }, { maxFileMb: 1 }).ok).toBe(true)
    bad(validateUpload({ ...ok, size: 2 * 1_048_576 }, { maxFileMb: 1 }))
    expect(validateUpload({ ...ok, size: 10 }, { allowedFormats: ['3mf'] }).ok).toBe(true)
    expect(validateUpload({ ...ok, size: 10, name: 'a.stl', format: 'stl' }, { allowedFormats: ['3mf'] })).toMatchObject({ ok: false })
  })
})

describe('other checks', () => {
  it('validates handles like the database', () => {
    expect(validateHandle('ferro-labs').ok).toBe(true)
    expect(validateHandle('abc').ok).toBe(true)
    for (const h of ['ab', 'Ab-c', '-abc', 'abc-', 'a_b', 'admin', 'library', 'x'.repeat(33)]) bad(validateHandle(h))
  })
  it('makes slugs', () => {
    expect(slugify('Bench light bracket!')).toBe('bench-light-bracket')
    expect(slugify('  Café  Déjà vu ')).toBe('cafe-deja-vu')
    expect(slugify('!!')).toMatch(/^[a-z0-9][a-z0-9-]{1,80}$/)
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(81)
  })
  it('validates devices', () => {
    const d = { deviceId: 'device-0001', name: 'Phone', platform: 'ios', signPub: 'A'.repeat(43) }
    expect(validateDevice(d).ok).toBe(true)
    bad(validateDevice({ ...d, deviceId: 'short' }))
    bad(validateDevice({ ...d, name: '' }))
    bad(validateDevice({ ...d, platform: 'palm' }))
    bad(validateDevice({ ...d, signPub: 'not a key!' }))
  })
})
