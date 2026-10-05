// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { neutralEdition, type EditionConfig } from '@slicerx/edition-config'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logLine, logTail, resetLog } from '../src/bugs/log'
import { enqueue, flush, queued, supabaseSender, type Sender } from '../src/bugs/outbox'
import { finishReport, LIMITS, osFromUserAgent, rpcArgs, type RawReport } from '../src/bugs/report'
import { buildManualReport, reportBody } from '../src/bugs/report-dialog'
import { fingerprint, isIPv6, normalizeFrame, scrub, sha256Hex, topFrames } from '../src/bugs/scrub'
import { acceptAgreement, AGREEMENT_VERSION, needsAgreement } from '../src/first-run/agreement'
import { normalizePrefs } from '../src/state/prefs'
import { get, set } from '../src/state/store'

const R = '[redacted]'

describe('scrubbing', () => {
  // Each item of the scrub list in docs/bug-intake.md, with the secret that must not survive.
  // Every value below is made up for the test (AKIAIOSFODNN7EXAMPLE is AWS's documented example key); none is a real credential.
  const cases: [string, string, string][] = [
    ['sxk_ tokens', 'token sxk_live_9f8e7d6c5b4a', '9f8e7d6c5b4a'],
    ['JWTs', 'session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcDEF_123', 'eyJhbGci'],
    ['bearer headers', 'Authorization: Bearer abcdef1234567890xyz', 'abcdef1234567890xyz'],
    ['basic auth headers', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
    ['API keys by name', 'api_key=hunter2hunter2', 'hunter2hunter2'],
    ['API keys in headers', 'X-Api-Key: 0123456789abcdef0123456789abcdef', '0123456789abcdef'],
    ['OpenAI style keys', 'using sk-proj-ABCDEFGHIJKLMNOPQRST', 'ABCDEFGHIJKLMNOPQRST'],
    ['Supabase secret keys', 'sb_secret_abcdefgh12345678', 'abcdefgh12345678'],
    ['GitHub tokens', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'abcdefghijklmnopqrstuvwxyz0123'],
    ['Slack tokens', 'xoxb-1234567890-abcdefghij', '1234567890-abcdefghij'],
    ['AWS keys', 'AKIAIOSFODNN7EXAMPLE', 'IOSFODNN7EXAMPLE'],
    ['Google keys', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', 'SyA1234567890'],
    ['passwords', '{"password":"correct horse"}', 'correct'],
    ['refresh tokens in query strings', 'GET /auth?refresh_token=r3fr3sh&x=1', 'r3fr3sh'],
    ['access codes in JSON', '{"access_code": "12345678"}', '12345678'],
    ['access codes in prose', 'the access code is 87654321', '87654321'],
    ['access codes in camel case', 'accessCode: "24681357"', '24681357'],
    ['Bambu cloud device list access codes', '{"dev_id": "0948AB510800227", "dev_access_code": "a1b2c3d4"}', 'a1b2c3d4'],
    ['Bambu cloud tokens', '{"accessToken": "AAB7f0e1d2c3b4a5968778695a4b3c2d1e0f", "refreshToken": "AAB9f8e7d6c5b4a3"}', 'AAB7f0e1d2c3b4a5968778695a4b3c2d1e0f'],
    ['LAN codes', 'lan_code=ABCD1234', 'ABCD1234'],
    ['serials by name', 'serial=01P00A123456789', '01P00A123456789'],
    ['Bambu Lab serials alone', 'printer 01S00C371500123 went offline', '01S00C371500123'],
    ['device ids', 'dev_id: 00M09A350100088', '00M09A350100088'],
    ['serial numbers in prose', 'serial number AB12CD34EF', 'AB12CD34EF'],
    ['passwords in URLs', 'mqtts://bblp:13572468@printer.local:8883', '13572468'],
    ['IPv4 addresses', 'printer at 192.168.1.42 answered', '192.168.1.42'],
    ['IPv4 with a port', 'connect 10.0.0.5:8883 failed', '10.0.0.5'],
    ['IPv6 addresses', 'peer fe80::1c2b:3cff:fe4d:5e6f%en0 dropped', 'fe80::'],
    ['full IPv6 addresses', '2001:0db8:85a3:0000:0000:8a2e:0370:7334', '2001:0db8'],
    ['emails', 'signed in as sean@example.com', 'sean@example.com'],
    ['macOS home folders', '/Users/jdoe/Library/Logs/x.log', 'jdoe'],
    ['Linux home folders', 'open /home/bob/.config/slicerx', 'bob'],
    ['Windows home folders', 'C:\\Users\\Sean\\AppData\\Roaming\\x', 'Sean'],
    ['Windows home folders with slashes', 'c:/Users/ana/Desktop', 'ana'],
    ['escaped Windows paths in JSON', '"C:\\\\Users\\\\Maya\\\\x.3mf"', 'Maya'],
    ['file URLs of home folders', 'file:///Users/jo/model.stl', 'jo/'],
  ]
  for (const [what, dirty, secret] of cases) {
    it(`removes ${what}`, () => {
      const clean = scrub(dirty)
      expect(clean).not.toContain(secret)
      expect(clean).toMatch(/\[redacted\]|~/)
    })
  }

  it('replaces home folders with ~ and keeps the rest of the path', () => {
    expect(scrub('/Users/jdoe/Library/Logs/x.log')).toBe('~/Library/Logs/x.log')
    expect(scrub('C:\\Users\\Sean\\AppData\\x')).toBe('~\\AppData\\x')
    expect(scrub('/home/bob/.config')).toBe('~/.config')
  })

  it('leaves ordinary log text alone', () => {
    for (const keep of ['12:34:56.789 info slice done', 'v0.1.0', 'line 42', 'sx_core::slice::run', 'layer 12 of 240, 0.2 mm', 'std::thread::spawn', 'G1 X10 Y20 E0.5', 'nozzle 220 °C', 'build 1.2.3', '~/Library/Logs/x.log'])
      expect(scrub(keep), keep).toBe(keep)
  })

  it('agrees with the Discord poller on its selftest string', () => {
    const dirty =
      'token sxk_live_9f8e7d6c5b4a and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcDEF_123 Authorization: Bearer abcdef1234567890xyz api_key=sk-proj-ABCDEFGHIJKLMNOPQRST ' +
      'accessCode: "12345678" serial=01P00A123456789 printer at 192.168.1.42 or fe80::1c2b:3cff:fe4d:5e6f%en0 mail sean@example.com path /Users/jdoe/Library/Logs/x.log ' +
      'C:\\Users\\Sean\\AppData\\x /home/bob/.config ghp_abcdefghijklmnopqrstuvwxyz0123 access code is 87654321'
    const clean = scrub(dirty)
    for (const leak of ['9f8e7d6c5b4a', 'eyJhbGci', 'abcdef1234567890xyz', 'ABCDEFGHIJKLMNOPQRST', '12345678', '01P00A123456789', '192.168.1.42', 'fe80::', 'sean@example.com', 'jdoe', 'Sean\\', 'bob', 'ghp_abc', '87654321'])
      expect(clean, leak).not.toContain(leak)
  })

  it('checks IP candidates the way Python does', () => {
    expect(scrub('version 1.2.3.400')).toBe('version 1.2.3.400')
    expect(scrub('time 12:34:56')).toBe('time 12:34:56')
    expect(isIPv6('::1')).toBe(true)
    expect(isIPv6('1:2:3:4:5:6:7:8')).toBe(true)
    expect(isIPv6('1:2:3')).toBe(false)
    expect(isIPv6('1::2::3')).toBe(false)
    expect(scrub(`loopback ::1 ok`)).toBe(`loopback <ip ${R}> ok`)
  })
})

describe('fingerprint', () => {
  const v8 = (line: number, chunk: string) => `TypeError: Cannot read properties of undefined (reading 'x')
    at sliceLayer (http://localhost:5173/assets/${chunk}.js:${line}:17)
    at runPlate (http://localhost:5173/assets/${chunk}.js:${line + 40}:3)
    at async Promise.all (index 0)`

  it('hashes with SHA-256', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3')
  })

  it('normalizes frames from V8, WebKit and Rust', () => {
    expect(normalizeFrame('    at sliceLayer (http://localhost:5173/assets/index-AbCd12_-.js:10:17)')).toBe('sliceLayer (index.js)')
    expect(normalizeFrame('sliceLayer@tauri://localhost/assets/index-Zz9Yx8W7.js:1:2345')).toBe('sliceLayer (index.js)')
    expect(normalizeFrame('    at http://localhost:5173/src/app.tsx?t=1700000000:10:5')).toBe('<anonymous> (app.tsx)')
    expect(normalizeFrame('  12: sx_core::slice::run::h0123456789abcdef')).toBe('sx_core::slice::run')
    expect(normalizeFrame('   3: std::panicking::begin_panic_handler::h0123456789abcdef')).toBeNull()
  })

  it('takes the top frames past the runtime noise', () => {
    const rust = ['   0: std::backtrace::Backtrace::force_capture::h1111111111111111', '             at /rustc/abc/library/std/src/backtrace.rs:331:13', '   1: slicerx::crash::hook::h2222222222222222', '   2: sx_core::slice::run::h3333333333333333', '             at ~/src/slice.rs:12:5', '   3: slicerx::slicing::slice::h4444444444444444'].join('\n')
    expect(topFrames(rust)).toEqual(['sx_core::slice::run', 'slicerx::slicing::slice'])
  })

  it('groups the same crash across builds and lines, and splits different ones', () => {
    const a = fingerprint('TypeError: x', v8(10, 'index-AbCdEfGh'))
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprint('TypeError: x', v8(99, 'index-ZyXwVuTs'))).toBe(a)
    expect(fingerprint('RangeError: x', v8(10, 'index-AbCdEfGh'))).not.toBe(a)
    expect(fingerprint('TypeError: x', v8(10, 'index-AbCdEfGh').replace('sliceLayer', 'drawLayer'))).not.toBe(a)
  })

  it('falls back to the message with its numbers and values taken out', () => {
    expect(fingerprint('Out of memory at 0x7fff1234 after 1200 ms', null)).toBe(fingerprint('Out of memory at 0x1 after 9 ms', null))
    expect(fingerprint('Failed to load "a.stl"', null)).toBe(fingerprint('Failed to load "b.stl"', null))
  })
})

const raw = (o: Partial<RawReport> = {}): RawReport => ({ kind: 'crash', title: 'TypeError: x', body: 'Automatic crash report.', stack: '    at f (http://x/a.js:1:1)', logTail: 'line', appVersion: '0.1.0 desktop', commit: '0f15b63a', os: 'macOS 15.1 (arm64)', printer: 'Bambu Lab A1 mini, firmware 01.04', ...o })

describe('reports', () => {
  it('scrubs every field', () => {
    const r = finishReport(raw({ title: 'Failed for sean@example.com', body: 'printer 192.168.1.9', stack: 'at /Users/sean/x.js', logTail: 'token=abc12345', printer: 'A1 serial 01P00A123456789', os: 'Linux /home/sean' }))
    const all = JSON.stringify(r)
    for (const leak of ['sean@example.com', '192.168.1.9', '/Users/sean', 'abc12345', '01P00A123456789', '/home/sean']) expect(all, leak).not.toContain(leak)
  })

  it('fits every field to its column', () => {
    const r = finishReport(raw({ title: 't'.repeat(500), body: 'b'.repeat(30_000), stack: 's'.repeat(60_000), logTail: Array.from({ length: 30_000 }, (_, i) => `line ${i} ${'x'.repeat(10)}`).join('\n'), appVersion: 'v'.repeat(60), commit: 'c'.repeat(60), os: 'o'.repeat(100), printer: 'p'.repeat(200) }))
    expect(r.title.length).toBeLessThanOrEqual(LIMITS.title)
    expect(r.body.length).toBeLessThanOrEqual(LIMITS.body)
    expect(r.stack!.length).toBeLessThanOrEqual(LIMITS.stack)
    expect(r.logTail!.length).toBeLessThanOrEqual(LIMITS.logTail)
    expect(r.appVersion.length).toBeLessThanOrEqual(LIMITS.appVersion)
    expect(r.commit.length).toBeLessThanOrEqual(LIMITS.commit)
    expect(r.os.length).toBeLessThanOrEqual(LIMITS.os)
    expect(r.printer!.length).toBeLessThanOrEqual(LIMITS.printer)
    // The log keeps its end, from the start of a line.
    expect(r.logTail!.endsWith('line 29999 xxxxxxxxxx')).toBe(true)
    expect(r.logTail!.startsWith('line ')).toBe(true)
  })

  it('fingerprints crashes only', () => {
    expect(finishReport(raw()).fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(finishReport(raw({ kind: 'manual' })).fingerprint).toBeNull()
  })

  it('maps to the arguments of submit_bug_report', () => {
    const args = rpcArgs(finishReport(raw({ printer: null, logTail: '' })), '7f3c1e1a-1b2c-4d5e-8f90-1234567890ab')
    expect(Object.keys(args)).toEqual(['p_kind', 'p_install_id', 'p_app_version', 'p_commit', 'p_os', 'p_printer', 'p_title', 'p_body', 'p_stack', 'p_log_tail', 'p_fingerprint'])
    expect(args['p_printer']).toBeNull()
    expect(args['p_log_tail']).toBeNull()
  })

  it('builds the manual report the preview shows', () => {
    const form = { title: 'Preview blank', happened: 'Nothing shows', steps: '1. Slice', expected: '', printer: 'A1 mini', attachLog: false }
    expect(reportBody(form)).toBe('What happened:\nNothing shows\n\nSteps to reproduce:\n1. Slice')
    const r = buildManualReport(form, { appVersion: '0.1.0', commit: 'abc', os: 'macOS', printer: null }, 'log line')
    expect(r).toMatchObject({ kind: 'manual', title: 'Preview blank', logTail: null, printer: 'A1 mini', fingerprint: null })
    expect(buildManualReport({ ...form, attachLog: true }, { appVersion: '0.1.0', commit: 'abc', os: 'macOS', printer: null }, 'log line').logTail).toBe('log line')
  })

  it('reads the OS from a user agent', () => {
    expect(osFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows 10 or 11')
    expect(osFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macOS')
    expect(osFromUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Linux')
  })
})

describe('the log', () => {
  beforeEach(() => resetLog())
  it('keeps the newest lines within the size asked for', () => {
    for (let i = 0; i < 1000; i++) logLine('info', [`message ${i}`, { n: i }])
    const tail = logTail(2000)
    expect(tail.length).toBeLessThanOrEqual(2000)
    expect(tail).toContain('message 999 {"n":999}')
    expect(tail).not.toContain('message 1 ')
    expect(tail.split('\n')[0]).toMatch(/^\d\d:\d\d:\d\d\.\d{3} info /)
  })
})

describe('the outbox', () => {
  beforeEach(() => localStorage.clear())
  const report = (title: string) => finishReport(raw({ kind: 'manual', title }))

  it('sends in order and empties', async () => {
    enqueue(report('a'))
    enqueue(report('b'))
    const sent: string[] = []
    const r = await flush(async (x) => (sent.push(x.title), { ok: true, id: 'id' }))
    expect(r).toEqual({ sent: 2, kept: 0, dropped: 0 })
    expect(sent).toEqual(['a', 'b'])
    expect(queued()).toEqual([])
  })

  it('keeps a report that failed for now and stops there', async () => {
    enqueue(report('a'))
    enqueue(report('b'))
    const send = vi.fn<Sender>(async () => ({ ok: false, retry: true, message: 'offline' }))
    expect(await flush(send)).toEqual({ sent: 0, kept: 1, dropped: 0 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(queued().map((q) => [q.report.title, q.attempts])).toEqual([['a', 1], ['b', 0]])
  })

  it('drops a report the server refuses for good', async () => {
    enqueue(report('a'))
    expect(await flush(async () => ({ ok: false, retry: false, message: 'too long' }))).toEqual({ sent: 0, kept: 0, dropped: 1 })
    expect(queued()).toEqual([])
  })

  it('holds at most ten reports, and holds back crash reports when asked', async () => {
    for (let i = 0; i < 14; i++) enqueue(report(String(i)))
    expect(queued().map((q) => q.report.title)).toEqual(['4', '5', '6', '7', '8', '9', '10', '11', '12', '13'])
    localStorage.clear()
    enqueue(finishReport(raw()))
    expect(await flush(async () => ({ ok: true, id: '' }), (r) => r.kind === 'manual')).toEqual({ sent: 0, kept: 0, dropped: 0 })
    expect(queued()).toHaveLength(1)
  })

  it('calls submit_bug_report with the anon key, and the session when signed in', async () => {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) })
      return new Response(JSON.stringify('11111111-2222-3333-4444-555555555555'), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const send = supabaseSender({ url: 'https://p.supabase.co/', anonKey: 'eyJanon.key.sig' }, () => 'install-id')
    expect(await send(report('a'))).toEqual({ ok: true, id: '11111111-2222-3333-4444-555555555555' })
    expect(calls[0]!.url).toBe('https://p.supabase.co/rest/v1/rpc/submit_bug_report')
    expect(calls[0]!.headers).toMatchObject({ apikey: 'eyJanon.key.sig', Authorization: 'Bearer eyJanon.key.sig' })
    expect(calls[0]!.body).toMatchObject({ p_kind: 'manual', p_install_id: 'install-id', p_title: 'a' })
    await supabaseSender({ url: 'https://p.supabase.co', anonKey: 'sb_publishable_abc' }, () => 'i', async () => 'session-jwt')(report('b'))
    expect(calls[1]!.headers['Authorization']).toBe('Bearer session-jwt')
    await supabaseSender({ url: 'https://p.supabase.co', anonKey: 'sb_publishable_abc' }, () => 'i')(report('c'))
    expect(calls[2]!.headers['Authorization']).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('tells lasting refusals from passing ones', async () => {
    const reply = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
    const send = supabaseSender({ url: 'https://p.supabase.co', anonKey: 'eyJanon.key.sig' }, () => 'i')
    reply(400, { code: '22001', message: 'a field is missing or too long' })
    expect(await send(report('a'))).toEqual({ ok: false, retry: false, message: 'a field is missing or too long' })
    reply(400, { code: 'P0001', hint: 'rate_limited', message: 'too many reports from this install; try again later' })
    expect(await send(report('a'))).toMatchObject({ ok: false, retry: true })
    reply(404, { code: 'PGRST202' })
    expect(await send(report('a'))).toMatchObject({ ok: false, retry: true })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await send(report('a'))).toMatchObject({ ok: false, retry: true, message: 'Failed to fetch' })
    vi.unstubAllGlobals()
  })
})

describe('the pre-alpha agreement', () => {
  const edition = (stage: 'pre-alpha' | 'stable'): EditionConfig => ({ ...neutralEdition(), release: { stage } })

  it('shows in pre-alpha builds until this version is accepted', () => {
    expect(needsAgreement(edition('pre-alpha'), { kind: 'desktop' }, null)).toBe(true)
    expect(needsAgreement(edition('pre-alpha'), { kind: 'web' }, { version: AGREEMENT_VERSION })).toBe(false)
    expect(needsAgreement(edition('pre-alpha'), { kind: 'web' }, { version: AGREEMENT_VERSION - 1 })).toBe(true)
    expect(needsAgreement(edition('stable'), { kind: 'desktop' }, null)).toBe(false)
    expect(needsAgreement(edition('pre-alpha'), { kind: 'embedded' }, null)).toBe(false)
  })

  it('stays out of the way only in a build for the end-to-end tests', () => {
    expect(needsAgreement(edition('pre-alpha'), { kind: 'web', build: { e2e: true } }, null)).toBe(false)
    expect(needsAgreement(edition('pre-alpha'), { kind: 'web', build: {} }, null)).toBe(true)
    vi.stubGlobal('navigator', { ...navigator, webdriver: true })
    expect(needsAgreement(edition('pre-alpha'), { kind: 'web' }, null)).toBe(true)
    vi.unstubAllGlobals()
  })

  it('records the version and date, and turns crash reports on', () => {
    set({ agreement: null, agreementOpen: true, crashReports: false })
    acceptAgreement(new Date('2026-10-04T12:00:00Z'))
    expect(get()).toMatchObject({ agreement: { version: AGREEMENT_VERSION, acceptedAt: '2026-10-04T12:00:00.000Z' }, agreementOpen: false, crashReports: true })
    const saved = normalizePrefs(JSON.parse(localStorage.getItem('slicerx.prefs.v1') ?? '{}'))
    expect(saved.agreement).toEqual({ version: AGREEMENT_VERSION, acceptedAt: '2026-10-04T12:00:00.000Z' })
  })

  it('reads acceptance and the install id back from prefs, dropping bad values', () => {
    expect(normalizePrefs({ agreement: { version: 1, acceptedAt: '2026-10-04' }, installId: '7f3c1e1a-1b2c-4d5e-8f90-1234567890ab' })).toMatchObject({ agreement: { version: 1, acceptedAt: '2026-10-04' }, installId: '7f3c1e1a-1b2c-4d5e-8f90-1234567890ab' })
    const bad = normalizePrefs({ agreement: { version: 'one' }, installId: 'not-a-uuid' })
    expect(bad.agreement).toBeNull()
    expect(bad.installId).toBeUndefined()
  })
})

describe('the agreement screen', () => {
  it('needs the box ticked, then records acceptance', async () => {
    const { createElement } = await import('react')
    const { flushSync } = await import('react-dom')
    const { createRoot } = await import('react-dom/client')
    const { Agreement } = await import('../src/first-run/agreement')
    const { EditionContext } = await import('../src/edition')
    set({ agreement: null, agreementOpen: true })
    const el = document.createElement('div')
    document.body.append(el)
    const pre = { ...neutralEdition(), release: { stage: 'pre-alpha' as const, bugReportsUrl: 'https://discord.com/channels/1555048815881355324/1556010155802628228' } }
    flushSync(() => createRoot(el).render(createElement(EditionContext, { value: pre }, createElement(Agreement))))
    const text = el.textContent ?? ''
    for (const part of ['heavy testing', 'Watch your printer', 'temperatures stay in range', '#bug-reports channel', 'Crash reports stay on', "What's sent?", `Agreement version ${AGREEMENT_VERSION}`]) expect(text, part).toContain(part)
    expect(text).not.toMatch(new RegExp('[\\u2013\\u2014]'))
    expect([...el.querySelectorAll('a')].some((a) => a.getAttribute('href') === pre.release.bugReportsUrl)).toBe(true)
    expect(el.querySelector('.fra-more')?.getAttribute('data-tip-body')).toContain('random install ID')
    const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Accept and continue'))!
    expect(button.disabled).toBe(true)
    flushSync(() => el.querySelector<HTMLInputElement>('.fra-check input')!.click())
    expect(button.disabled).toBe(false)
    flushSync(() => button.click())
    expect(get().agreementOpen).toBe(false)
    expect(get().agreement?.version).toBe(AGREEMENT_VERSION)
    el.remove()
  })
})

describe('automatic crash reports', () => {
  it('queue a scrubbed report for an error nothing handled, once per stack', async () => {
    localStorage.clear()
    const { startBugReports, resetBugReports } = await import('../src/bugs/reports')
    resetBugReports()
    set({ crashReports: false, printerId: null })
    const host = { kind: 'web', build: { version: '0.1.0', commit: '0f15b63a', sourceUrl: '' } } as never
    const stop = startBugReports(host, { ...neutralEdition(), release: { stage: 'pre-alpha' } })
    expect(get().crashReports).toBe(true)
    expect(get().installId).toMatch(/^[0-9a-f-]{36}$/)
    console.warn('connecting to 192.168.1.20 as sean@example.com')
    const error = new Error('Cannot read the plate at /Users/sean/plate.3mf')
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }))
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }))
    window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' }))
    await vi.waitFor(() => expect(queued()).toHaveLength(1))
    const r = queued()[0]!.report
    expect(r).toMatchObject({ kind: 'crash', title: 'Error: Cannot read the plate at ~/plate.3mf', appVersion: '0.1.0 web', commit: '0f15b63a' })
    expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(r.logTail).toContain('<ip [redacted]>')
    expect(JSON.stringify(r)).not.toMatch(/sean|192\.168\.1\.20/)
    stop()
    resetBugReports()
  })

  it('carry a log of what the app did even when nothing went to the console', async () => {
    localStorage.clear()
    vi.resetModules()
    const { startBugReports, resetBugReports } = await import('../src/bugs/reports')
    const { queued: fresh } = await import('../src/bugs/outbox')
    const store = await import('../src/state/store')
    store.set({ crashReports: true, printerId: null, workspace: 'prepare' })
    const host = { kind: 'desktop', build: { version: '0.1.0', commit: 'c4b5d1c1', sourceUrl: '' } } as never
    const stop = startBugReports(host, { ...neutralEdition(), release: { stage: 'pre-alpha' } })
    store.set({ workspace: 'preview' })
    store.set({ slice: { status: 'error', message: 'Nothing to slice' } })
    const error = new Error('Minified React error #185')
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }))
    await vi.waitFor(() => expect(fresh()).toHaveLength(1))
    const log = fresh()[0]!.report.logTail ?? ''
    expect(log).toMatch(/note {2}Reference Slicer 0\.1\.0 \(c4b5d1c1, desktop\) started in prepare/)
    expect(log).toContain('Workspace: preview')
    expect(log).toContain('Slicing failed: Nothing to slice')
    expect(log.trimEnd().split('\n').pop()).toContain('Crash: Error: Minified React error #185')
    stop()
    resetBugReports()
  })

  it('save the log when the page goes away, and tell a reload key from a crash at the next start', async () => {
    const start = async (pageLoads: number) => {
      vi.resetModules()
      const reports = await import('../src/bugs/reports')
      const outbox = await import('../src/bugs/outbox')
      const store = await import('../src/state/store')
      store.set({ crashReports: true, printerId: null, workspace: 'prepare' })
      reports.resetBugReports()
      reports.registerCrashHost({ take: async () => ({ reports: [], pageLoads, os: 'Windows 10.0.26200 (x86_64)' }), ack: async () => {}, testPanic: async () => {} })
      const host = { kind: 'desktop', build: { version: '0.1.0', commit: 'c4b5d1c1', sourceUrl: '' } } as never
      const stop = reports.startBugReports(host, { ...neutralEdition(), release: { stage: 'pre-alpha' } })
      return { stop, outbox, reports }
    }
    localStorage.clear()
    // First page: the person presses F5. The page unloads and saves its log at once, without waiting for the timer.
    const first = await start(1)
    window.dispatchEvent(new Event('pagehide'))
    const saved = localStorage.getItem('slicerx.bugs.lastlog.v1') ?? ''
    expect(saved).toContain('started in prepare')
    expect(saved.trimEnd().split('\n').pop()).toMatch(/note {2}The page is unloading\.$/)
    first.stop()
    // Second page in the same run of the shell: a reload report with that log, saying how the page went.
    const second = await start(2)
    await vi.waitFor(() => expect(second.outbox.queued()).toHaveLength(1))
    const r = second.outbox.queued()[0]!.report
    expect(r.title).toBe('The window was reloaded deliberately')
    expect(r.body).toContain('a deliberate reload (key, menu or script), not a crash')
    expect(r.logTail).toContain('The page is unloading.')
    second.stop()
    // A page that stopped without unloading says so instead.
    localStorage.clear()
    localStorage.setItem('slicerx.bugs.lastlog.v1', '03:15:33.551 note  Workspace: preview')
    const third = await start(2)
    await vi.waitFor(() => expect(third.outbox.queued()).toHaveLength(1))
    const crash = third.outbox.queued()[0]!.report
    expect(crash.title).toBe('The window reloaded unexpectedly')
    expect(crash.body).toContain('most likely stopped or hung')
    // The two group apart in the bug channel.
    expect(crash.fingerprint).not.toBe(r.fingerprint)
    third.stop()
    third.reports.registerCrashHost(null)
    third.reports.resetBugReports()
  })
})
