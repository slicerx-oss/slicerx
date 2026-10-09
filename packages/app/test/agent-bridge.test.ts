// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The agent bridge's page side: what it records (console, network, toasts, dialogs) and never keeps, how it finds and
// uses controls by test id, what it refuses, and the state and slice summary it reads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeshHandle, SliceResult } from '@slicerx/contracts'
import { registerCommand } from '../src/commands/registry'
import { appState, createPageBridge, exportCommands, installCapture, redact, safeUrl, sliceSummary, type Capture } from '../src/agent-bridge'
import { click, elements, fill, find, images, pressKey, refusal, testids, waitFor } from '../src/agent-bridge/dom'
import { get, set, type PlateEntry } from '../src/state/store'

const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 10], openEdges: 0, parts: [{ name: 'body', slot: 1, triangles: 12 }] })
const entry = (id: string, extra: Partial<PlateEntry> = {}): PlateEntry => ({ id, name: id, handle: handle(id), parts: [], colors: [], transform: [], ...extra })
const result = (over: Partial<SliceResult> = {}): SliceResult => ({
  id: '7',
  engine: 'sx',
  layerCount: 50,
  layerZ: new Float32Array(),
  layerTimeS: new Float32Array(),
  stats: { timeS: 1234.4, filamentMm: [100, 20], filamentG: [3.21, 0.5], cost: 0, toolChanges: 2 },
  stageMicros: {},
  wallMs: 812.3,
  warnings: [
    { code: 'thin_wall', message: 'Thin wall', objectId: 'cube' },
    { code: 'long_bridge', message: 'Long bridge' },
  ],
  ...over,
})

let capture: Capture | null = null
afterEach(() => {
  capture?.stop()
  capture = null
  document.body.innerHTML = ''
})

describe('what the bridge records', () => {
  it('masks tokens in console text', () => {
    // A made-up token, put together here so secret scanners do not take the test for a leak.
    const jwt = ['eyJ', 'hbGciOiJIUzI1NiJ9', '.eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0', '.c2lnbmF0', 'dXJlc2ln'].join('')
    expect(redact(`auth ${jwt} done`)).toBe('auth [jwt] done')
    expect(redact('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer [redacted]')
    expect(redact('slicerx://auth/callback?code=secret123&state=x')).toBe('slicerx://auth/callback?code=[redacted]&state=x')
    expect(redact('https://x.supabase.co/rest/v1/listings?apikey=sb_publishable_1')).toContain('apikey=[redacted]')
  })

  it('keeps an address without its query or fragment', () => {
    expect(safeUrl('https://abc.supabase.co/auth/v1/otp?redirect_to=x#frag')).toBe('https://abc.supabase.co/auth/v1/otp')
    expect(safeUrl('/rest/v1/listings?select=*', 'http://tauri.localhost/')).toBe('http://tauri.localhost/rest/v1/listings')
    expect(safeUrl('data:image/png;base64,AAAA')).toBe('data:')
    expect(safeUrl('blob:http://tauri.localhost/1234')).toBe('blob:')
  })

  it('records console lines and page errors in order, with a marker to read from', () => {
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    capture = installCapture(window)
    console.warn('first', { n: 1 })
    const m = capture.marker()
    console.warn('second token=abc')
    window.dispatchEvent(new ErrorEvent('error', { message: 'Boom' }))
    const all = capture.read('console')
    expect(all.entries.map((e) => e['text'])).toEqual(['first {"n":1}', 'second token=abc', 'Boom'])
    expect(all.entries.map((e) => e['level'])).toEqual(['warn', 'warn', 'pageerror'])
    const after = capture.read('console', m)
    expect(after.entries).toHaveLength(2)
    expect(after.marker).toBe(capture.marker())
    expect(typeof after.entries[0]!['at']).toBe('string')
    capture.stop()
    quiet.mockRestore()
  })

  it('logs backend calls with method, address and status only', async () => {
    const real = window.fetch
    window.fetch = vi.fn(async () => new Response('{"secret":"body"}', { status: 401 })) as typeof fetch
    capture = installCapture(window)
    await window.fetch('https://abc.supabase.co/auth/v1/token?grant_type=pkce', { method: 'post', headers: { Authorization: 'Bearer x' }, body: '{"code":"y"}' })
    const [e] = capture.read('network').entries
    expect(e).toMatchObject({ kind: 'network', method: 'POST', url: 'https://abc.supabase.co/auth/v1/token', status: 401, ok: false })
    expect(JSON.stringify(e)).not.toMatch(/secret|Bearer|grant_type|"code"/)
    capture.stop()
    window.fetch = real
  })

  it('sees toasts and dialogs come and go', () => {
    capture = installCapture(window)
    const toast = document.createElement('div')
    toast.className = 'sx-toast'
    toast.setAttribute('data-tone', 'error')
    toast.textContent = 'Sign-in did not finish: otp_expired'
    document.body.append(toast)
    const dlg = document.createElement('dialog')
    dlg.setAttribute('data-testid', 'signin-dialog')
    dlg.innerHTML = '<h2>Sign in</h2>'
    document.body.append(dlg)
    dlg.setAttribute('open', '')
    capture.flush()
    expect(capture.read('toast').entries.map((e) => [e['text'], e['tone']])).toEqual([['Sign-in did not finish: otp_expired', 'error']])
    expect(capture.openDialogs()).toEqual([{ title: 'Sign in', testid: 'signin-dialog', since: expect.any(String) }])
    dlg.removeAttribute('open')
    capture.flush()
    expect(capture.read('dialog').entries.map((e) => [e['event'], e['title']])).toEqual([
      ['open', 'Sign in'],
      ['close', 'Sign in'],
    ])
    // Seen once, even when the page changes around it.
    document.body.append(document.createElement('span'))
    capture.flush()
    expect(capture.read('toast').entries).toHaveLength(1)
  })

  it('puts the console and fetch back when it stops', () => {
    const log = console.log
    const f = window.fetch
    capture = installCapture(window)
    expect(console.log).not.toBe(log)
    capture.stop()
    expect(console.log).toBe(log)
    expect(window.fetch).toBe(f)
  })
})

describe('controls by test id', () => {
  it('clicks with the pointer sequence and reports how many matched', () => {
    document.body.innerHTML = '<button data-testid="vault-tab">Vault</button><button data-testid="vault-tab">Vault</button>'
    const seen: string[] = []
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) document.body.addEventListener(t, () => seen.push(t))
    expect(click(document, 'vault-tab')).toEqual({ clicked: 'vault-tab', matches: 2 })
    expect(seen).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
  })

  it('finds a control by an old id it still answers to', () => {
    document.body.innerHTML = '<button data-testid="tab-model" data-testid-alias="tab-design">Model</button>'
    expect(click(document, 'tab-design')).toEqual({ clicked: 'tab-model', matches: 1 })
    expect(elements(document, 'tab-model')).toHaveLength(1)
  })

  it('refuses disabled, missing and destructive controls', () => {
    document.body.innerHTML = [
      '<button data-testid="send-again" disabled>Send again in 30 s</button>',
      '<button data-testid="danger-delete-account">Delete account</button>',
      '<div data-agent-refuse><button data-testid="go">Start</button></div>',
      '<div class="print-sheet"><button data-testid="ps-ok">OK</button></div>',
      '<button data-testid="signout">Sign out</button>',
    ].join('')
    expect(() => click(document, 'send-again')).toThrow(/disabled/)
    expect(() => click(document, 'nope')).toThrow(/no element/)
    expect(() => click(document, 'bad"id')).toThrow(/test id/)
    for (const id of ['danger-delete-account', 'go', 'ps-ok']) expect(refusal(find(document, id).el)).not.toBeNull()
    expect(() => click(document, 'go')).toThrow(/does not use/)
    expect(refusal(find(document, 'signout').el)).toBeNull()
  })

  it('fills an input so React sees the typing', () => {
    document.body.innerHTML = '<form><input data-testid="signin-email" type="email"></form>'
    const input = document.querySelector('input')!
    const events: string[] = []
    input.addEventListener('input', () => events.push(`input:${input.value}`))
    input.addEventListener('change', () => events.push('change'))
    expect(fill(document, 'signin-email', 'qa1@qa.slicerx.app')).toEqual({ filled: 'signin-email', length: 18 })
    expect(events).toEqual(['input:qa1@qa.slicerx.app', 'change'])
    expect(() => fill(document, 'signin-email', 5)).toThrow(/string/)
  })

  it('presses Escape on the open dialog and Enter in a form', () => {
    document.body.innerHTML = '<dialog data-testid="d" open><form><input data-testid="field"></form></dialog>'
    const dlg = document.querySelector('dialog')!
    const submitted = vi.fn((e: Event) => e.preventDefault())
    dlg.querySelector('form')!.addEventListener('submit', submitted)
    const form = dlg.querySelector('form')!
    form.requestSubmit ??= () => form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(pressKey(document, { key: 'Enter', testid: 'field' })).toMatchObject({ pressed: 'Enter', did: 'submitted the form' })
    expect(submitted).toHaveBeenCalledOnce()
    const cancelled = vi.fn()
    dlg.addEventListener('cancel', cancelled)
    dlg.close ??= () => dlg.removeAttribute('open')
    expect(pressKey(document, { key: 'Escape' })).toMatchObject({ did: 'cancelled the dialog' })
    expect(cancelled).toHaveBeenCalledOnce()
    expect(() => pressKey(document, { key: '' })).toThrow(/key/)
  })

  it('waits for a control and gives up in time', async () => {
    document.body.innerHTML = ''
    setTimeout(() => (document.body.innerHTML = '<button data-testid="later">Later</button>'), 150)
    await expect(waitFor(document, 'later', 'visible', 2000)).resolves.toMatchObject({ testid: 'later', state: 'visible' })
    await expect(waitFor(document, 'never', 'present', 200)).rejects.toThrow(/not present/)
    await expect(waitFor(document, 'later', 'absent', 0)).rejects.toThrow(/timeout|not absent/)
  })

  it('reads a control with its state and data attributes, never a password', () => {
    document.body.innerHTML = '<article data-testid="vault-card" data-listing="l-1">Cube</article><input data-testid="pw" type="password" value="secret"><input data-testid="t" value="Tower">'
    expect(elements(document, 'vault-card')).toEqual([{ index: 0, tag: 'article', visible: true, enabled: true, text: 'Cube', data: { listing: 'l-1' } }])
    expect(elements(document, 'pw')[0]).not.toHaveProperty('value')
    expect(elements(document, 't')[0]).toMatchObject({ value: 'Tower' })
  })

  it('reads the pictures in a control: loaded, still pending or failed, without the query', () => {
    document.body.innerHTML =
      '<article data-testid="vault-card"><img id="a" src="https://p.example/storage/v1/object/public/cover.webp?token=abc"><span><img id="b" loading="lazy" src="https://p.example/logo.png"></span><img id="c" src="https://p.example/gone.png"></article>'
    const set = (id: string, complete: boolean, width: number) => {
      const img = document.getElementById(id) as HTMLImageElement
      Object.defineProperty(img, 'complete', { value: complete })
      Object.defineProperty(img, 'naturalWidth', { value: width })
      Object.defineProperty(img, 'naturalHeight', { value: width ? 300 : 0 })
    }
    set('a', true, 400)
    set('b', false, 0)
    set('c', true, 0)
    const card = elements(document, 'vault-card')[0] as { images: Record<string, unknown>[] }
    expect(card.images.map((i) => [i['url'], i['state']])).toEqual([
      ['https://p.example/storage/v1/object/public/cover.webp', 'loaded'],
      ['https://p.example/logo.png', 'pending'],
      ['https://p.example/gone.png', 'failed'],
    ])
    expect(card.images[0]).toMatchObject({ width: 400, height: 300 })
    expect(card.images[1]).toMatchObject({ lazy: true })
    expect(images(document.getElementById('a')!)).toHaveLength(1)
    expect(JSON.stringify(card)).not.toContain('token')
  })

  it('lists the test ids on the page', () => {
    document.body.innerHTML = '<i data-testid="a"></i><i data-testid="a"></i><i data-testid="b" style="display:none"></i>'
    expect(testids(document)).toEqual({ a: 2 })
    expect(testids(document, false)).toEqual({ a: 2, b: 1 })
  })
})

describe('the state an agent reads', () => {
  beforeEach(() =>
    set({
      workspace: 'prepare',
      plate: [entry('cube', { source: { modelId: 'listing-1' } }), entry('peg', { printable: false })],
      plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }],
      activePlate: 'plate-1',
      slotSetup: {},
      printerSlots: [],
      printerId: 'hand-a1',
      printerModel: { vendor: 'Bambu Lab', model: 'A1' },
      slice: { status: 'done', result: result(), stale: false },
      autoSlice: false,
      unsavedPrompt: null,
    }),
  )

  it('names the tab, each object with its parts and warnings, and the printer', () => {
    const s = appState(get())
    expect(s['tab']).toBe('prepare')
    const plate = s['plate'] as { objects: Record<string, unknown>[]; warnings: unknown[] }
    expect(plate.objects.map((o) => [o['id'], o['printable']])).toEqual([
      ['cube', true],
      ['peg', false],
    ])
    expect(plate.objects[0]).toMatchObject({ parts: [{ name: 'body', slot: 1, triangles: 12 }], vaultListing: 'listing-1', warnings: [{ code: 'thin_wall', message: 'Thin wall', objectId: 'cube' }] })
    expect(plate.warnings).toEqual([{ code: 'long_bridge', message: 'Long bridge' }])
    expect(s['printer']).toMatchObject({ id: 'hand-a1', vendor: 'Bambu Lab', model: 'A1' })
    expect(Array.isArray(s['filament'])).toBe(true)
    // Nothing asked of the geometry engine yet in this session.
    expect(s['geometry']).toEqual({ answered: {}, failed: {}, lastError: null, loadError: null })
    // No slice yet in this session.
    expect(s['lastSlice']).toBeNull()
  })

  it('summarizes a finished slice and every other status', () => {
    const base = { plate: [entry('cube')], plates: [], activePlate: 'plate-1', autoSlice: true }
    expect(sliceSummary({ ...base, slice: { status: 'done', result: result(), stale: false } })).toMatchObject({ status: 'done', layers: 50, timeS: 1234, filamentG: 3.71, toolChanges: 2, warnings: [{ code: 'thin_wall' }, { code: 'long_bridge' }] })
    expect(sliceSummary({ ...base, slice: { status: 'idle' } })).toEqual({ status: 'idle', autoSlice: true })
    expect(sliceSummary({ ...base, slice: { status: 'error', message: 'No room' } })).toEqual({ status: 'error', autoSlice: true, message: 'No room' })
    expect(sliceSummary({ ...base, slice: { status: 'running', progress: null, startedAt: 0 } })).toMatchObject({ status: 'running' })
  })

  it('says which export commands are on, so a sealed Vault design shows no mesh export', () => {
    const offs = [
      registerCommand({ id: 'export-plate-stl', title: 'Export the plate as STL', section: 'plate', enabled: () => false, run: () => undefined }),
      registerCommand({ id: 'export-gcode', title: 'Export G-code', section: 'plate', run: () => undefined }),
      registerCommand({ id: 'plate-clear', title: 'Clear the plate', section: 'plate', run: () => undefined }),
    ]
    try {
      const on = exportCommands()
      expect(on['export-plate-stl']).toBe(false)
      expect(on['export-gcode']).toBe(true)
      expect(on).not.toHaveProperty('plate-clear')
    } finally {
      offs.forEach((off) => off())
    }
  })

  it('answers tools, refuses unknown ones and waits for the host', async () => {
    capture = installCapture(window)
    const bridge = createPageBridge(capture)
    await expect(bridge.handle('nope', {})).rejects.toThrow(/no tool/)
    await expect(bridge.handle('user', {})).rejects.toMatchObject({ code: 'not_ready' })
    bridge.attach({ store: { session: async () => ({ userId: 'u1', email: 'qa1@qa.slicerx.app', handle: 'qa' }) } } as never)
    await expect(bridge.handle('user', {})).resolves.toEqual({ signedIn: true, userId: 'u1', email: 'qa1@qa.slicerx.app' })
    const state = (await bridge.handle('state', {})) as Record<string, unknown>
    expect(state).toMatchObject({ tab: 'prepare', dialogs: [], toasts: [] })
    expect(typeof state['marker']).toBe('number')
    await expect(bridge.handle('export_info', {})).resolves.toMatchObject({ id: '7' })
    set({ slice: { status: 'idle' } })
    await expect(bridge.handle('export_info', {})).rejects.toMatchObject({ code: 'not_ready' })
    // The Slice command is not registered in this test, so the refusal comes back at once instead of a wait.
    await expect(bridge.handle('slice', {})).rejects.toMatchObject({ code: 'not_ready' })
  })

  it('refuses to export a slice the plate has changed since', async () => {
    capture = installCapture(window)
    const bridge = createPageBridge(capture)
    set({ slice: { status: 'done', result: result(), stale: false } })
    await expect(bridge.handle('export_info', {})).resolves.toMatchObject({ id: '7' })
    set({ slice: { status: 'done', result: result(), stale: true } })
    await expect(bridge.handle('export_info', {})).rejects.toMatchObject({ code: 'refused', message: expect.stringMatching(/changed after the last slice/) })
  })
})
