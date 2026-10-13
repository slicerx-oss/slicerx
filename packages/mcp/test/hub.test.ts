// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The person-only path end to end against a scripted sx-link hub: the MCP server pairs as an
// agent, registers the card with its work, and records the hub's approval.done report.
import { describe, expect, it } from 'vitest'
import { hashParams } from '@slicerx/contracts'
import { DEFAULT_POLICY } from '@slicerx/contracts'
import { base64ToBytes, bytesToBase64, pakeAnswer } from '@slicerx/link-client'
import { createContext } from '../src/index'
import { connect, data, text } from './helpers'

type Handler = (method: string, params: Record<string, unknown>, sock: FakeSocket) => unknown

/** A WebSocket stand-in speaking sx-link's JSON protocol: requests by id, events by name. */
class FakeSocket {
  static OPEN = 1
  readyState = 1
  binaryType = 'blob'
  sent: { method: string; params: Record<string, unknown> }[] = []
  private listeners = new Map<string, ((e: unknown) => void)[]>()
  constructor(private readonly handler: Handler) {
    queueMicrotask(() => this.fire('open', {}))
  }
  addEventListener(type: string, cb: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb])
  }
  removeEventListener() {}
  fire(type: string, e: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb(e)
  }
  event(body: unknown) {
    this.fire('message', { data: JSON.stringify(body) })
  }
  send(raw: string) {
    const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> }
    this.sent.push({ method, params })
    void Promise.resolve()
      .then(() => this.handler(method, params ?? {}, this))
      .then(
        (result) => this.event({ id, result }),
        (e: { code?: string; message?: string }) => this.event({ id, error: { code: e.code ?? 'protocol', message: e.message ?? 'failed' } }),
      )
  }
  close() {
    this.readyState = 3
    this.fire('close', {})
  }
}

const printer = { id: 'bay-4', name: 'Bay 4', vendor: 'Voron Design', model: 'Voron 2.4 350', plugin: 'moonraker', nozzleCount: 1 }
const status = { printerId: 'bay-4', state: 'idle', nozzles: [{ current: 30, target: 0 }], bed: { current: 25, target: 0 }, slots: [], cameraAvailable: false, updatedAt: '2026-10-01T20:00:00.000Z' }

const PORT = 47615
const HELLO_CONTEXT = new TextEncoder().encode('sx-link hello v2\n')

/** Answers `hello` the way a real hub does: an Ed25519 signature over both nonces and the port. */
async function signedHello(keys: CryptoKeyPair, clientNonce: string) {
  const hubNonce = crypto.getRandomValues(new Uint8Array(32))
  const transcript = Buffer.concat([HELLO_CONTEXT, Buffer.from(clientNonce, 'base64'), hubNonce, Buffer.from([(PORT >> 8) & 0xff, PORT & 0xff])])
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, transcript)
  const hubKey = await crypto.subtle.exportKey('raw', keys.publicKey)
  return {
    ctx: { hubKey: new Uint8Array(hubKey), port: PORT, clientNonce: new Uint8Array(Buffer.from(clientNonce, 'base64')), hubNonce },
    reply: { hubKey: Buffer.from(hubKey).toString('base64'), hubNonce: Buffer.from(hubNonce).toString('base64'), port: PORT, sig: Buffer.from(sig).toString('base64') },
  }
}

const CODES = { app: 'APPS-CODE', agent: 'AGNT-CODE', watch: 'WTCH-CODE' }

function scriptedHub(outcome: { ok: boolean; code?: string; message?: string }, proves = true, fleet: { printer: Record<string, unknown>; status: Record<string, unknown> } = { printer, status }, app?: (method: string, args: Record<string, unknown>) => unknown) {
  let socket: FakeSocket | undefined
  const keys = crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>
  let hello: Awaited<ReturnType<typeof signedHello>> | undefined
  let run: ReturnType<typeof pakeAnswer> = null
  const WS = class extends FakeSocket {
    constructor() {
      super(async (method, params, s) => {
        switch (method) {
          // The client refuses a program that cannot prove it is a hub, so `proves: false` is the impostor.
          case 'hello':
            if (!proves) throw { code: 'bad_request', message: 'no hello' }
            hello = await signedHello(await keys, String(params['nonce']))
            return hello.reply
          // The code exchange: the hub's CPace messages, then its half of the confirmation.
          case 'pair': {
            if (!hello) throw { code: 'unauthorized', message: 'no hello' }
            if (typeof params['pake'] === 'string') {
              run = pakeAnswer(CODES, hello.ctx, base64ToBytes(params['pake']), () => crypto.getRandomValues(new Uint8Array(32)))
              return { pake: Object.fromEntries(Object.entries(run?.yb ?? {}).map(([r, m]) => [r, bytesToBase64(m)])) }
            }
            const tags = Object.fromEntries(Object.entries((params['confirm'] ?? {}) as Record<string, string>).map(([r, t]) => [r, base64ToBytes(t)]))
            const ok = run?.check(tags)
            run = null
            if (!ok) throw { code: 'unauthorized', message: 'wrong pairing code' }
            return { paired: true, role: ok.role, confirm: bytesToBase64(ok.confirm) }
          }
          case 'plugins':
            return []
          case 'list':
            return [fleet.printer]
          case 'status':
            return fleet.status
          case 'approvals.register': {
            const req = params['request'] as { id: string }
            // A person approves in the app a moment later; the hub runs the work and reports.
            setTimeout(() => s.event({ event: 'approval.done', data: { requestId: req.id, printerId: 'bay-4', ...outcome } }), 20)
            return { registered: true, answeredIn: 'app' }
          }
          // The app link: the hub hands the call to the open app and returns its answer.
          case 'app.call':
            if (!app) throw { code: 'app_link_off', message: 'the app link is off' }
            return app(String(params['method']), (params['args'] ?? {}) as Record<string, unknown>)
          default:
            return {}
        }
      })
      socket = this
    }
  }
  return { WS: WS as unknown as typeof WebSocket, sent: () => socket?.sent ?? [] }
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 60))
}

describe('pinning the hub', () => {
  it('sends no code to a hub that cannot prove the pinned key', async () => {
    const hub = scriptedHub({ ok: true }, false)
    await expect(
      createContext({ engine: 'stub', policy: DEFAULT_POLICY, printers: 'link', linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkHubKey: 'pinned-key', linkWebSocket: hub.WS }),
    ).rejects.toThrow(/did not prove|not the SlicerX hub|Nothing was sent/)
    expect(hub.sent().map((s) => s.method)).toEqual(['hello'])
    expect(JSON.stringify(hub.sent())).not.toContain('AGNT-CODE')
  })

  it('sends no code to a program that does not answer hello when nothing is pinned', async () => {
    const hub = scriptedHub({ ok: true }, false)
    await expect(
      createContext({ engine: 'stub', policy: DEFAULT_POLICY, printers: 'link', linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS }),
    ).rejects.toThrow(/did not prove/)
    expect(hub.sent().map((s) => s.method)).toEqual(['hello'])
    expect(JSON.stringify(hub.sent())).not.toContain('AGNT-CODE')
  })
})

describe('person-only work through a scripted hub', () => {
  it('pairs as an agent, sends the card with its work and records the run', async () => {
    const hub = scriptedHub({ ok: true })
    const h = await connect({ printers: 'link', linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })
    expect(hub.sent().find((s) => s.method === 'pair' && 'confirm' in s.params)?.params['role']).toBe('agent')
    // The code goes to a proven hub only through the exchange, never in clear.
    expect(JSON.stringify(hub.sent())).not.toContain('AGNT-CODE')

    const r = await h.call('slicerx_printer_gcode', { printerId: 'bay-4', line: 'G28' })
    const req = data<{ status: string; request_id: string }>(r)
    expect(req.status).toBe('needs_person')
    expect(text(r)).toMatch(/in SlicerX or on the phone/)

    const reg = hub.sent().find((s) => s.method === 'approvals.register')
    expect(reg?.params['work']).toEqual({ kind: 'gcode', printerId: 'bay-4', line: 'G28' })
    const card = reg?.params['request'] as { id: string; origin: string; actions: { action: string; target: string; paramsHash: string }[] }
    expect(card.id).toBe(req.request_id)
    expect(card.origin).toBe('mcp')
    expect(card.actions).toEqual([{ action: 'printer.gcode', target: 'bay-4', paramsHash: await hashParams({ printerId: 'bay-4', line: 'G28' }) }])
    // MCP never asks for a token for this card.
    expect(hub.sent().some((s) => s.method === 'approvals.grant')).toBe(false)

    await settle()
    const p = data<{ pending: { request_id: string; status: string }[] }>(await h.call('slicerx_pending_approvals'))
    expect(p.pending).toEqual([expect.objectContaining({ request_id: req.request_id, status: 'done' })])
  })

  it('reports a run the hub could not finish', async () => {
    const hub = scriptedHub({ ok: false, message: 'Bay 4 went offline' })
    const h = await connect({ printers: 'link', linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })
    await h.call('slicerx_printer_set_temperature', { printerId: 'bay-4', heater: 'bed', celsius: 60 })
    await settle()
    const p = data<{ pending: { status: string; message?: string }[] }>(await h.call('slicerx_pending_approvals'))
    expect(p.pending[0]).toMatchObject({ status: 'failed', message: 'Bay 4 went offline' })
  })

  // A Bambu Lab A1 mini on Authorization Control firmware without Developer Mode: status comes through, the send does
  // not. The client reads the code and both remedies back, from the run and from the printer's status.
  it('says what a Bambu Lab printer without Developer Mode needs, with both remedies', async () => {
    const a1 = { id: 'bay-4', name: 'Bay 4', vendor: 'Bambu Lab', model: 'Bambu Lab A1 mini', plugin: 'bambu-lan', nozzleCount: 1 }
    const a1Status = { ...status, live: { needsDeveloperMode: true } }
    const message = 'printer bay-4 may need Developer Mode to take prints from this app: It sends status, but the file upload failed (FTPS upload timed out).'
    const hub = scriptedHub({ ok: false, code: 'needs_developer_mode', message }, true, { printer: a1, status: a1Status })
    const h = await connect({ printers: 'link', linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })
    await h.call('slicerx_printer_gcode', { printerId: 'bay-4', line: 'G28' })
    await settle()
    type Remedy = { id: string; title: string; steps: string[]; note: string }
    const p = data<{ pending: { status: string; code?: string; message?: string; remedies?: Remedy[] }[] }>(await h.call('slicerx_pending_approvals'))
    expect(p.pending[0]).toMatchObject({ status: 'failed', code: 'needs_developer_mode', message })
    const remedies = p.pending[0]?.remedies ?? []
    expect(remedies.map((r) => r.id)).toEqual(['developer_mode', 'bambu_connect'])
    // The A series' own menu path, from Bambu Lab's wiki, and nothing for the other families.
    expect(remedies[0]?.steps.join(' ')).toMatch(/swipe to page 3/)
    expect(remedies[0]?.steps.join(' ')).not.toMatch(/WLAN, then LAN Only Mode/)
    expect(remedies[0]?.note).toMatch(/Bambu Handy/)
    expect(remedies[1]?.title).toBe('Send with Bambu Connect')

    // Read back: the printer's status says it before the next send.
    const st = await h.call('slicerx_printer_status', { printerId: 'bay-4' })
    expect(st.isError).toBeFalsy()
    const body = JSON.stringify(data(st))
    expect(body).toContain('"needsDeveloperMode":true')
    expect(body).toContain('Send with Bambu Connect')
    expect(text(st)).toMatch(/needs Developer Mode or Bambu Connect/)
    // The text said it was a guess, so the client reads sure: false.
    expect(p.pending[0]).toMatchObject({ sure: false })
  })

  // The printer's card had no room: the client reads the code and the one remedy back, never Developer Mode.
  it('says when a printer has no room for the file, with the remedy', async () => {
    const message = "printer bay-4 has no room for the file: its storage is full (FTP 452 after STOR). Free space on the printer's SD card."
    const hub = scriptedHub({ ok: false, code: 'printer_storage_full', message })
    const h = await connect({ printers: 'link', linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })
    await h.call('slicerx_printer_gcode', { printerId: 'bay-4', line: 'G28' })
    await settle()
    type Remedy = { id: string; title: string; steps: string[] }
    const p = data<{ pending: { status: string; code?: string; message?: string; remedies?: Remedy[]; sure?: boolean }[] }>(await h.call('slicerx_pending_approvals'))
    expect(p.pending[0]).toMatchObject({ status: 'failed', code: 'printer_storage_full', message })
    expect(p.pending[0]?.sure).toBeUndefined()
    expect(p.pending[0]?.remedies?.map((r) => r.id)).toEqual(['free_storage'])
    expect(p.pending[0]?.remedies?.[0]?.steps.join(' ')).toMatch(/Delete old print files/)
  })
})

describe('--app through a scripted hub', () => {
  const opts = (hub: ReturnType<typeof scriptedHub>) => ({ printers: 'link' as const, linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS, app: 'required' as const })

  it('runs the design calls in the open app and reads them back from there', async () => {
    const calls: [string, Record<string, unknown>][] = []
    const hub = scriptedHub({ ok: true }, true, undefined, (method, args) => {
      calls.push([method, args])
      return method === 'design.new' ? { summary: 'New design Clip', output: { design: 'obj_1' } } : { summary: '1 design', output: { designs: [{ design: 'obj_1', name: 'Clip' }] } }
    })
    const h = await connect(opts(hub))
    const made = await h.call('slicerx_design_new', { name: 'Clip' })
    expect(made.isError, text(made)).toBeFalsy()
    expect(data<{ output: unknown }>(made).output).toEqual({ design: 'obj_1', in: 'app' })
    const list = await h.call('slicerx_design_list')
    expect(data<{ output: unknown }>(list).output).toEqual({ designs: [{ design: 'obj_1', name: 'Clip' }], in: 'app' })
    expect(calls.map(([m]) => m)).toEqual(['design.new', 'design.list'])
    expect(calls[0]![1]).toEqual({ name: 'Clip' })
  })

  it('refuses a design call while the link is off, and runs nothing here', async () => {
    const h = await connect(opts(scriptedHub({ ok: true })))
    const r = await h.call('slicerx_design_new', { name: 'Clip' })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/^Error: not_configured: the app link is off: turn it on in .+'s Settings, or run without --app/)
    const list = await h.call('slicerx_design_list')
    expect(list.isError).toBe(true)
    expect(text(list)).toMatch(/not_configured/)
  })

  it('needs printers through sx-link', async () => {
    await expect(createContext({ engine: 'stub', policy: DEFAULT_POLICY, printers: 'demo', app: 'required' })).rejects.toThrow(/--app needs printers through sx-link/)
  })
})

describe('the mimir cloud share setting through a scripted hub', () => {
  const link = (hub: ReturnType<typeof scriptedHub>) => ({ printers: 'link' as const, linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })

  it('reads the setting from the open app, the way a client checks it', async () => {
    const hub = scriptedHub({ ok: true }, true, undefined, (method) => {
      if (method !== 'mimir.share') throw { code: 'bad_request', message: `unknown method ${method}` }
      return { cloud: true, onCloud: true, share: false, noticeRead: true }
    })
    const h = await connect(link(hub))
    const r = await h.call('slicerx_mimir_share')
    expect(r.isError, text(r)).toBeFalsy()
    expect(data<{ output: unknown }>(r).output).toEqual({ cloud: true, on_cloud: true, share: false, notice_read: true })
    expect(text(r)).toMatch(/Sharing mimir sessions is off/)
  })

  it('says how to reach the app while the link is off, or without sx-link', async () => {
    const h = await connect(link(scriptedHub({ ok: true })))
    const r = await h.call('slicerx_mimir_share')
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/^Error: not_configured: the app link to .+ does not answer \(app_link_off\)/)
    const demo = await connect({ printers: 'demo' })
    const off = await demo.call('slicerx_mimir_share')
    expect(off.isError).toBe(true)
    expect(text(off)).toMatch(/--printers link/)
  })
})

describe('mimir cloud status through a scripted hub', () => {
  const link = (hub: ReturnType<typeof scriptedHub>) => ({ printers: 'link' as const, linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })
  const quota = { edition: 'slicerx', day: '2026-10-13', installUsed: 120_000, installCap: 500_000, ipUsed: 120_000, ipCap: 2_000_000, editionOpen: true }

  it('reads the status from the open app in a stable shape, with nothing secret in it', async () => {
    const hub = scriptedHub({ ok: true }, true, undefined, (method) => {
      if (method !== 'mimir.status') throw { code: 'bad_request', message: `unknown method ${method}` }
      // anything else the app might add stays out of what the client gets
      return { cloud: true, enabled: true, needsSignIn: false, signedIn: true, quota: { ...quota, token: 'install-token' }, quotaError: null, key: 'sk-never' }
    })
    const h = await connect(link(hub))
    const r = await h.call('slicerx_mimir_cloud_status')
    expect(r.isError, text(r)).toBeFalsy()
    const out = data<{ output: unknown }>(r).output
    expect(out).toEqual({
      cloud: true,
      enabled: true,
      signed_in: true,
      needs_sign_in: false,
      quota: { day: '2026-10-13', edition: 'slicerx', open: true, install: { used_usd: 0.12, cap_usd: 0.5, left_usd: 0.38 }, network: { used_usd: 0.12, cap_usd: 2 }, resets: 'midnight, Australia/Melbourne' },
      quota_error: null,
    })
    expect(JSON.stringify(r)).not.toMatch(/install-token|sk-never/)
    expect(text(r)).toMatch(/mimir runs on mimir cloud\. \$0\.38 of \$0\.50/)
  })

  it('reads a build without the cloud, and one that waits for a sign-in', async () => {
    const answers = [
      { cloud: false, enabled: false, needsSignIn: false, signedIn: null, quota: null, quotaError: null },
      { cloud: true, enabled: false, needsSignIn: true, signedIn: false, quota: null, quotaError: null },
    ]
    const hub = scriptedHub({ ok: true }, true, undefined, () => answers.shift())
    const h = await connect(link(hub))
    const none = await h.call('slicerx_mimir_cloud_status')
    expect(data<{ output: unknown }>(none).output).toEqual({ cloud: false, enabled: false, signed_in: null, needs_sign_in: false, quota: null, quota_error: null })
    expect(text(none)).toMatch(/has no mimir cloud in this build/)
    const waits = await h.call('slicerx_mimir_cloud_status')
    expect(data<{ output: unknown }>(waits).output).toMatchObject({ cloud: true, enabled: false, signed_in: false, needs_sign_in: true })
    expect(text(waits)).toMatch(/waits for the person to sign in/)
  })

  it('says how to reach the app while the link is off, or without sx-link', async () => {
    const h = await connect(link(scriptedHub({ ok: true })))
    const r = await h.call('slicerx_mimir_cloud_status')
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/^Error: not_configured: the app link to .+ does not answer \(app_link_off\)/)
    const demo = await connect({ printers: 'demo' })
    const off = await demo.call('slicerx_mimir_cloud_status')
    expect(off.isError).toBe(true)
    expect(text(off)).toMatch(/--printers link/)
  })
})

describe('a dimension sheet through a scripted hub', () => {
  const opts = (hub: ReturnType<typeof scriptedHub>) => ({ printers: 'link' as const, linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })

  it('goes to the person in the open app, and the client reads the answer back', async () => {
    const calls: string[] = []
    const hub = scriptedHub({ ok: true }, true, undefined, (method) => {
      calls.push(method)
      return method === 'sheet.ask' ? { sheetId: 'csheet_1', state: 'waiting' } : { sheetId: 'csheet_1', state: 'confirmed', answer: { values: { bore: 6.4 }, changed: ['bore'] } }
    })
    const h = await connect(opts(hub))
    const asked = await h.call('slicerx_app_sheet_ask', { title: 'Clip sizes', dims: [{ key: 'bore', label: 'Cable bore', value: 6.2, unit: 'mm', source: 'guess' }] })
    expect(asked.isError, text(asked)).toBeFalsy()
    expect(text(asked)).toMatch(/waiting for the person/)
    const got = await h.call('slicerx_app_sheet_get', { sheet_id: 'csheet_1' })
    expect(data<{ output: unknown }>(got).output).toEqual({ sheetId: 'csheet_1', state: 'confirmed', answer: { values: { bore: 6.4 }, changed: ['bore'] } })
    expect(calls).toEqual(['sheet.ask', 'sheet.get'])
  })

  it('is not offered without sx-link', async () => {
    const demo = await connect({ printers: 'demo' })
    const listed = await demo.client.listTools()
    expect(listed.tools.some((t) => t.name.startsWith('slicerx_app_sheet'))).toBe(false)
  })
})
