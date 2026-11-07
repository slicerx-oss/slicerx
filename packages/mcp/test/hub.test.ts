// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The person-only path end to end against a scripted sx-link hub: the MCP server pairs as an
// agent, registers the card with its work, and records the hub's approval.done report.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  // Home is the device page's Home button for a client: a person approves G28 on the card, and only while the
  // printer is idle or finished, as the button is enabled.
  it('homes an idle printer through a home card a person approves, and refuses mid-print', async () => {
    const hub = scriptedHub({ ok: true })
    const h = await connect({ printers: 'link', linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })
    const r = await h.call('slicerx_printer_home', { printerId: 'bay-4' })
    expect(data<{ status: string }>(r).status).toBe('needs_person')
    const reg = hub.sent().find((s) => s.method === 'approvals.register')
    // The hub runs its own home rules when the person approves (printer state and plate), not a bare G28.
    expect(reg?.params['work']).toEqual({ kind: 'home', printerId: 'bay-4' })
    const card = reg?.params['request'] as { title: string; lines: string[]; actions: { action: string; paramsHash: string }[] }
    expect(card.title).toBe('Home all axes of bay-4?')
    expect(card.lines.join(' ')).toMatch(/plate is clear/)
    // Its own action, so the card never reads as the raw line: the hub homes under its rules when it is approved.
    expect(card.actions).toEqual([{ action: 'printer.home', target: 'bay-4', paramsHash: await hashParams({ printerId: 'bay-4' }) }])
  })

  it.each([
    ['idle', true],
    ['finished', true],
    ['printing', false],
    ['paused', false],
    ['preparing', false],
    ['error', false],
    ['offline', false],
  ] as const)('a client asks to home a printer that is %s: card made %s', async (state, made) => {
    const hub = scriptedHub({ ok: true }, true, { printer, status: { ...status, state } })
    const h = await connect({ printers: 'link', linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })
    const r = await h.call('slicerx_printer_home', { printerId: 'bay-4' })
    expect(hub.sent().some((s) => s.method === 'approvals.register')).toBe(made)
    if (made) expect(data<{ status: string }>(r).status).toBe('needs_person')
    else {
      expect(r.isError).toBe(true)
      expect(text(r)).toMatch(/only while the printer is idle or finished/)
    }
  })

  // A filament change (M600) is its own card: the firmware parks the head for the swap, so it goes mid-print, and the hub
  // asks about the plate on an idle or finished printer.
  it('asks for a filament change on its own card, and refuses a printer that cannot take one', async () => {
    const hub = scriptedHub({ ok: true }, true, { printer, status: { ...status, state: 'printing' } })
    const h = await connect({ printers: 'link', linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })
    const r = await h.call('slicerx_printer_filament_change', { printerId: 'bay-4' })
    expect(data<{ status: string }>(r).status).toBe('needs_person')
    const reg = hub.sent().find((s) => s.method === 'approvals.register')
    expect(reg?.params['work']).toEqual({ kind: 'filament_change', printerId: 'bay-4' })
    const card = reg?.params['request'] as { title: string; lines: string[]; actions: { action: string; paramsHash: string }[] }
    expect(card.title).toBe('Change the filament on bay-4?')
    expect(card.lines.join(' ')).toMatch(/parks the head/)
    expect(card.actions).toEqual([{ action: 'printer.filament_change', target: 'bay-4', paramsHash: await hashParams({ printerId: 'bay-4' }) }])
    for (const state of ['error', 'offline', 'preparing'] as const) {
      const off = scriptedHub({ ok: true }, true, { printer, status: { ...status, state } })
      const c = await connect({ printers: 'link', linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: off.WS })
      const refused = await c.call('slicerx_printer_filament_change', { printerId: 'bay-4' })
      expect(refused.isError, state).toBe(true)
      expect(off.sent().some((s) => s.method === 'approvals.register'), state).toBe(false)
    }
  })

  it('reports the hub refusing a home card approved after a print started', async () => {
    const hub = scriptedHub({ ok: false, code: 'bad_state', message: 'the printer homes only while it is idle or finished' })
    const h = await connect({ printers: 'link', linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })
    await h.call('slicerx_printer_home', { printerId: 'bay-4' })
    await settle()
    const p = data<{ pending: { status: string; code?: string }[] }>(await h.call('slicerx_pending_approvals'))
    expect(p.pending[0]).toMatchObject({ status: 'failed', code: 'bad_state' })
  })

  it('reads the firmware and each filament unit\'s humidity and drying back from printer status', async () => {
    const live = { units: [{ id: 'A', kind: 'ams-2-pro', climate: { humidityPct: 22, humidityLevel: 2, tempC: 26, drying: false } }, { id: 'E', kind: 'ams-ht', climate: { humidityPct: 11, tempC: 45, drying: true, dryMinutesLeft: 200 } }] }
    const hub = scriptedHub({ ok: true }, true, { printer, status: { ...status, firmware: '01.04.00.00', live } })
    const h = await connect({ printers: 'link', linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })
    const s = data<{ output: { firmware?: string; live?: typeof live } }>(await h.call('slicerx_printer_status', { printerId: 'bay-4' })).output
    expect(s.firmware).toBe('01.04.00.00')
    expect(s.live?.units).toEqual(live.units)
    const list = data<{ output: { id: string; status: { firmware?: string; live?: typeof live } }[] }>(await h.call('slicerx_printer_list', { detail: 'full' })).output
    expect(list[0]?.status.firmware).toBe('01.04.00.00')
    expect(list[0]?.status.live?.units?.[1]?.climate).toEqual({ humidityPct: 11, tempC: 45, drying: true, dryMinutesLeft: 200 })
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

describe('a message to mimir with files, through a scripted hub', () => {
  const opts = (hub: ReturnType<typeof scriptedHub>) => ({ printers: 'link' as const, linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })

  it('reads a picture and a PDF from disk, sends them to the open app, and reads the conversation back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sx-mimir-ask-'))
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    const pdf = Buffer.from('%PDF-1.4\n%%EOF')
    await writeFile(join(dir, 'sketch.png'), png)
    await writeFile(join(dir, 'bracket.pdf'), pdf)
    const seen: { method: string; args: Record<string, unknown> }[] = []
    const hub = scriptedHub({ ok: true }, true, undefined, (method, args) => {
      seen.push({ method, args })
      if (method === 'mimir.ask') return { sessionId: 's_1', said: args['message'], attachments: (args['files'] as { name: string; type: string }[]).map((f) => ({ name: f.name, type: f.type, bytes: 1 })) }
      if (method === 'mimir.sessions') return { sessions: [{ id: 's_1' }] }
      return { id: 's_1', turns: [{ said: 'Make a bracket for this', attachments: ['sketch.png', 'bracket.pdf'], steps: [{ kind: 'said', text: 'I can see the drawing.' }, { kind: 'choice', askId: 'ask_1', title: 'Confirm the part', question: 'This one?', choices: [{ id: 'same', label: 'Yes' }], picked: 'same', answeredOn: { kind: 'phone', name: 'Pocket' } }] }] }
    })
    const h = await connect(opts(hub))
    const asked = await h.call('slicerx_mimir_ask', { message: 'Make a bracket for this', files: [join(dir, 'sketch.png'), join(dir, 'bracket.pdf')] })
    expect(asked.isError, text(asked)).toBeFalsy()
    expect(text(asked)).toMatch(/with sketch\.png, bracket\.pdf/)
    expect(seen[0]).toEqual({ method: 'mimir.ask', args: { message: 'Make a bracket for this', files: [{ name: 'sketch.png', type: 'image/png', data: png.toString('base64') }, { name: 'bracket.pdf', type: 'application/pdf', data: pdf.toString('base64') }] } })
    const back = await h.call('slicerx_mimir_session', {})
    expect(data<{ output: { turns: { attachments: string[] }[] } }>(back).output.turns[0]!.attachments).toEqual(['sketch.png', 'bracket.pdf'])
    // a question answered on the person's phone keeps saying so through the tool
    expect(data<{ output: { turns: { steps: Record<string, unknown>[] }[] } }>(back).output.turns[0]!.steps[1]).toMatchObject({ kind: 'choice', picked: 'same', answeredOn: { kind: 'phone', name: 'Pocket' } })
    expect(seen.map((s) => s.method)).toEqual(['mimir.ask', 'mimir.sessions', 'mimir.session'])
  })

  it('refuses a file that is not a picture or a PDF before anything is sent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sx-mimir-ask-'))
    await writeFile(join(dir, 'part.stl'), 'solid x')
    const seen: string[] = []
    const hub = scriptedHub({ ok: true }, true, undefined, (method) => {
      seen.push(method)
      return {}
    })
    const h = await connect(opts(hub))
    const out = await h.call('slicerx_mimir_ask', { message: 'hi', files: [join(dir, 'part.stl')] })
    expect(out.isError).toBe(true)
    expect(text(out)).toMatch(/part\.stl isn't an image or a PDF/)
    expect(seen).toEqual([])
  })
})

describe('turning down the question mimir waits on, through a scripted hub', () => {
  const opts = (hub: ReturnType<typeof scriptedHub>) => ({ printers: 'link' as const, linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })

  /** The open app as the link sees it: one chat whose run waits on a question until it is turned down. */
  function app() {
    const seen: { method: string; args: Record<string, unknown> }[] = []
    let waiting: { askId: string; title: string; question: string; choices: { id: string; label: string }[] } | null = { askId: 'ask_1', title: 'Confirm the part', question: 'Is this the thermostat on your wall?', choices: [{ id: 'same', label: 'Yes, that one' }, { id: 'other', label: 'A different model' }] }
    let said: string | undefined
    const handle = (method: string, args: Record<string, unknown>): unknown => {
      seen.push({ method, args })
      if (method === 'mimir.sessions') return { sessions: [{ id: 's_1' }] }
      if (method === 'mimir.session') return { id: 's_1', stats: { questions: 1, questionsDismissed: waiting ? 0 : 1 }, waiting, turns: [{ said: 'a wall mount', steps: [{ kind: 'choice', askId: 'ask_1', picked: waiting ? null : '', ...(waiting ? {} : { dismissed: true, ...(said ? { said } : {}) }) }] }] }
      if (method === 'mimir.ask') {
        if (waiting) throw { code: 'busy', message: 'mimir is answering a message now' }
        return { sessionId: 's_1', said: args['message'], attachments: [] }
      }
      if (method === 'mimir.dismiss') {
        if (!waiting || (args['askId'] !== undefined && args['askId'] !== waiting.askId)) throw { code: 'not_found', message: 'mimir is not waiting on that question' }
        const askId = waiting.askId
        said = typeof args['said'] === 'string' ? args['said'] : undefined
        waiting = null
        return { sessionId: 's_1', askId, dismissed: true, ...(said ? { said } : {}) }
      }
      return {}
    }
    return { seen, handle }
  }

  it('reads the waiting question, turns it down with words, and mimir.ask goes through only after', async () => {
    const a = app()
    const h = await connect(opts(scriptedHub({ ok: true }, true, undefined, a.handle)))
    const before = await h.call('slicerx_mimir_session', {})
    expect(data<{ output: { waiting: { askId: string } | null } }>(before).output.waiting?.askId).toBe('ask_1')
    const blocked = await h.call('slicerx_mimir_ask', { message: 'are you there?' })
    expect(blocked.isError).toBe(true)
    expect(text(blocked)).toMatch(/busy/)

    const out = await h.call('slicerx_mimir_dismiss', { askId: 'ask_1', said: 'it is a different model' })
    expect(out.isError, text(out)).toBeFalsy()
    expect(data<{ output: unknown }>(out).output).toEqual({ sessionId: 's_1', askId: 'ask_1', dismissed: true, said: 'it is a different model' })
    expect(a.seen.find((s) => s.method === 'mimir.dismiss')).toEqual({ method: 'mimir.dismiss', args: { askId: 'ask_1', said: 'it is a different model' } })

    const after = data<{ output: { waiting: unknown; stats: { questionsDismissed: number }; turns: { steps: Record<string, unknown>[] }[] } }>(await h.call('slicerx_mimir_session', { id: 's_1' })).output
    expect(after.waiting).toBeNull()
    expect(after.stats.questionsDismissed).toBe(1)
    expect(after.turns[0]!.steps[0]).toMatchObject({ dismissed: true, said: 'it is a different model' })
    const asked = await h.call('slicerx_mimir_ask', { message: 'thanks' })
    expect(asked.isError, text(asked)).toBeFalsy()
  })

  it('a stale askId is not_found, a long said is invalid_input before anything is sent, and a closed tab is not_configured', async () => {
    const a = app()
    const h = await connect(opts(scriptedHub({ ok: true }, true, undefined, a.handle)))
    const stale = await h.call('slicerx_mimir_dismiss', { askId: 'ask_old' })
    expect(stale.isError).toBe(true)
    expect(text(stale)).toMatch(/not_found/)
    const long = await h.call('slicerx_mimir_dismiss', { said: 'x'.repeat(1001) })
    expect(long.isError).toBe(true)
    // the server's input check refuses it before the call reaches the app (the app refuses it too, as invalid_input)
    expect(text(long)).toMatch(/Input validation error.*<=1000 characters at said/)
    expect(a.seen.filter((s) => s.method === 'mimir.dismiss').map((s) => s.args)).toEqual([{ askId: 'ask_old' }])
    // with no askId the one waiting is turned down
    const now = await h.call('slicerx_mimir_dismiss', {})
    expect(data<{ output: { askId: string } }>(now).output.askId).toBe('ask_1')
    const again = await h.call('slicerx_mimir_dismiss', {})
    expect(text(again)).toMatch(/not_found/)

    const closed = await connect(opts(scriptedHub({ ok: true }, true, undefined, (method) => {
      if (method === 'mimir.dismiss') throw { code: 'not_ready', message: 'the mimir tab is not open in the app' }
      return {}
    })))
    const shut = await closed.call('slicerx_mimir_dismiss', {})
    expect(shut.isError).toBe(true)
    expect(text(shut)).toMatch(/not_configured/)
  })

  it('says it never picks an answer or stops the run, and the ask says a waiting question blocks it', async () => {
    const h = await connect(opts(scriptedHub({ ok: true }, true, undefined, app().handle)))
    const tools = (await h.client.listTools()).tools
    const dismiss = tools.find((t) => t.name === 'slicerx_mimir_dismiss')!
    expect(dismiss.description).toMatch(/does not pick an answer and does not stop mimir's run/)
    expect(tools.find((t) => t.name === 'slicerx_mimir_ask')!.description).toMatch(/slicerx_mimir_dismiss/)
  })
})

describe("the person's saved presets, through a scripted hub", () => {
  // Under the default policy: the app's own dialog is the person's approval of each preset write, so nothing asks here.
  const opts = (hub: ReturnType<typeof scriptedHub>) => ({ printers: 'link' as const, linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })

  it('lists, compares, copies and puts back, each through the app link and read back', async () => {
    const seen: { method: string; args: Record<string, unknown> }[] = []
    let layer = 0.28
    const hub = scriptedHub({ ok: true }, true, undefined, (method, args) => {
      seen.push({ method, args })
      const listed = { id: 'up_1', kind: 'process', name: 'Fast draft', settings: 1, inUse: false }
      if (method === 'presets.list') return { presets: [listed] }
      if (method === 'presets.compare') return { preset: listed, with: { id: 'up_2', name: 'Fine detail' }, differ: layer === 0.28 ? 1 : 0, groups: [{ group: 'quality', label: 'Quality', rows: [{ key: 'layer_height', label: 'Layer height', differs: true, a: layer, b: 0.12, aText: `${layer} mm`, bText: '0.12 mm' }] }], unknownKeys: [] }
      if (method === 'presets.copy') {
        layer = 0.12
        return { preset: listed, key: 'layer_height', label: 'Layer height', value: 0.12, from: 'Fine detail', undoId: 'pu_1' }
      }
      if (method === 'presets.undo') {
        if (args['undoId'] !== 'pu_1' || layer === 0.28) throw { code: 'not_found', message: 'No copy to put back with that undoId' }
        layer = 0.28
        return { preset: listed, key: 'layer_height', value: 0.28 }
      }
      return {}
    })
    const h = await connect(opts(hub))
    const listed = await h.call('slicerx_app_presets', {})
    expect(listed.isError, text(listed)).toBeFalsy()
    const cmp = await h.call('slicerx_app_preset_compare', { preset: 'Fast draft', with: 'Fine detail' })
    expect(data<{ output: { differ: number } }>(cmp).output.differ).toBe(1)
    const copied = await h.call('slicerx_app_preset_copy', { preset: 'Fast draft', key: 'layer_height', with: 'Fine detail' })
    expect(copied.isError, text(copied)).toBeFalsy()
    expect(data<{ output: { value: number; undoId: string } }>(copied).output).toMatchObject({ value: 0.12, undoId: 'pu_1' })
    expect(data<{ output: { differ: number } }>(await h.call('slicerx_app_preset_compare', { preset: 'Fast draft', with: 'Fine detail' })).output.differ).toBe(0)
    expect(data<{ output: { value: number } }>(await h.call('slicerx_app_preset_undo', { undoId: 'pu_1' })).output.value).toBe(0.28)
    const again = await h.call('slicerx_app_preset_undo', { undoId: 'pu_1' })
    expect(again.isError, text(again)).toBe(true)
    expect(text(again)).toMatch(/not_found/)
    expect(seen.map((s) => s.method)).toEqual(['presets.list', 'presets.compare', 'presets.copy', 'presets.compare', 'presets.undo', 'presets.undo'])
    expect(seen[2]!.args).toEqual({ preset: 'Fast draft', key: 'layer_height', with: 'Fine detail' })
  })
})

describe('saved preset writes from a client allowed to read only, through a scripted hub', () => {
  const opts = (hub: ReturnType<typeof scriptedHub>) => ({ printers: 'link' as const, linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })

  it('refuses the copy and the undo with not_supported before any dialog, and the preset stays as it was', async () => {
    let layer = 0.28
    // The hub holds this client to read: its grant check refuses an edit method before the call reaches the app, so the
    // app never puts a question to the person. Every call that gets past the grant check is recorded as the dialog a
    // write would raise, and a write that got through would change the preset.
    const dialogs: string[] = []
    const edits = new Set(['presets.copy', 'presets.undo'])
    const grantRead = (method: string) => {
      if (edits.has(method)) throw { code: 'read_only', message: 'the person allowed Bench agent to read the open project, not to change it' }
    }
    const hub = scriptedHub({ ok: true }, true, undefined, (method) => {
      grantRead(method)
      if (edits.has(method)) {
        dialogs.push(method)
        layer = 0.12
        return {}
      }
      if (method === 'presets.compare') return { preset: { name: 'Fast draft' }, with: { name: 'Fine detail' }, differ: layer === 0.28 ? 1 : 0, groups: [], unknownKeys: [] }
      return {}
    })
    const h = await connect(opts(hub))
    for (const [tool, args] of [['slicerx_app_preset_copy', { preset: 'Fast draft', key: 'layer_height', with: 'Fine detail' }], ['slicerx_app_preset_undo', { undoId: 'pu_1' }]] as const) {
      const r = await h.call(tool, args)
      expect(r.isError, tool).toBe(true)
      const e = data<{ error: { code: string; message: string; details?: { appLink?: string } } }>(r).error
      expect(e.code, tool).toBe('not_supported')
      expect(e.details?.appLink, tool).toBe('read_only')
      expect(e.message).toMatch(/not to change it/)
    }
    expect(dialogs).toEqual([])
    expect(layer).toBe(0.28)
    expect(data<{ output: { differ: number } }>(await h.call('slicerx_app_preset_compare', { preset: 'Fast draft', with: 'Fine detail' })).output.differ).toBe(1)
  })

  it('asks the client nothing itself under the default policy: the call goes straight to the app', async () => {
    const seen: string[] = []
    const hub = scriptedHub({ ok: true }, true, undefined, (method) => {
      seen.push(method)
      return method === 'presets.copy' ? { preset: { name: 'Fast draft' }, label: 'Layer height', value: 0.12, from: 'Fine detail', undoId: 'pu_1' } : { preset: { name: 'Fast draft' }, key: 'layer_height', value: 0.28 }
    })
    const h = await connect(opts(hub))
    const copied = await h.call('slicerx_app_preset_copy', { preset: 'Fast draft', key: 'layer_height', with: 'Fine detail' })
    expect(copied.isError, text(copied)).toBeFalsy()
    expect(JSON.stringify(copied.structuredContent ?? {})).not.toMatch(/approval_required/)
    expect((await h.call('slicerx_app_preset_undo', { undoId: 'pu_1' })).isError).toBeFalsy()
    expect(seen).toEqual(['presets.copy', 'presets.undo'])
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

describe('the mimir tab through a scripted hub', () => {
  const link = (hub: ReturnType<typeof scriptedHub>) => ({ printers: 'link' as const, linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })

  it('reads what answers in the tab: a model on Auto, a local model here or on the network, the scripts, or nothing yet', async () => {
    const answers = [
      { link: 'model', provider: 'anthropic', model: 'claude-haiku-5-5', auto: { huginn: 'claude-haiku-5-5', muninn: 'claude-sonnet-5-5' }, local: false, where: 'remote', tools: ['pilot.sheet', 'design.new', 'geom.extrude', 'app.slice', 'printer.queue'], key: 'sk-never' },
      {
        link: 'model',
        provider: 'openai-compatible',
        model: 'qwen3:8b-16k',
        auto: null,
        local: true,
        where: 'computer',
        tools: ['kb.search', 'pilot.tools', 'design.new', 'geom.mirror', 'design.timeline', 'app.slice'],
        turns: { build: ['kb.search', 'pilot.tools', 'design.new'], shape: ['kb.search', 'pilot.tools', 'geom.mirror'], edit: ['kb.search', 'pilot.tools', 'design.timeline'], app: ['kb.search', 'pilot.tools', 'app.slice', 7], print: ['kb.search', 'pilot.tools'], extra: ['x'] },
      },
      { link: 'model', provider: 'openai-compatible', model: 'qwen3:8b-16k', auto: null, local: true, where: 'network', tools: ['kb.search', 'design.new', 'app.slice'] },
      { link: 'model', provider: 'openai-compatible', model: 'qwen3:8b-16k', auto: null, local: true, where: 'remote', tools: ['kb.search', 'design.new', 'app.slice'] },
      { link: 'scripted', provider: 'scripted', model: 'scripted', auto: null, tools: ['pilot.sheet', 'geom.extrude'] },
      { link: 'none', provider: null, model: null, auto: null, tools: [] },
    ]
    const hub = scriptedHub({ ok: true }, true, undefined, (method) => {
      if (method !== 'mimir.tab') throw { code: 'bad_request', message: `unknown method ${method}` }
      return answers.shift()
    })
    const h = await connect(link(hub))
    const model = await h.call('slicerx_mimir_tab')
    expect(model.isError, text(model)).toBeFalsy()
    expect(data<{ output: unknown }>(model).output).toEqual({ link: 'model', provider: 'anthropic', model: 'claude-haiku-5-5', auto: { huginn: 'claude-haiku-5-5', muninn: 'claude-sonnet-5-5' }, local: false, where: 'remote', tools: ['pilot.sheet', 'design.new', 'geom.extrude', 'app.slice', 'printer.queue'], turns: null })
    expect(JSON.stringify(model)).not.toMatch(/sk-never/)
    expect(text(model)).toMatch(/runs anthropic on Auto: claude-haiku-5-5, and claude-sonnet-5-5 for a picture/)
    const local = await h.call('slicerx_mimir_tab')
    expect(data<{ output: { local: boolean; where: string } }>(local).output).toMatchObject({ local: true, where: 'computer' })
    expect(text(local)).toMatch(/runs openai-compatible with qwen3:8b-16k on this computer, a local model, offering 6 tools, one set of them per message \(build 3, shape 3, edit 3, app 3, print 2\)/)
    // each set's tools, as the app lists them: only the four sets, only names
    expect(data<{ output: { turns: unknown } }>(local).output.turns).toEqual({ build: ['kb.search', 'pilot.tools', 'design.new'], shape: ['kb.search', 'pilot.tools', 'geom.mirror'], edit: ['kb.search', 'pilot.tools', 'design.timeline'], app: ['kb.search', 'pilot.tools', 'app.slice'], print: ['kb.search', 'pilot.tools'] })
    // a local model is not always on this computer: the address decides
    const network = await h.call('slicerx_mimir_tab')
    expect(data<{ output: { local: boolean; where: string; turns: unknown } }>(network).output).toMatchObject({ local: true, where: 'network', turns: null })
    expect(text(network)).toMatch(/with qwen3:8b-16k on a computer on your network, a local model/)
    expect(text(network)).not.toMatch(/this computer/)
    const away = await h.call('slicerx_mimir_tab')
    expect(text(away)).toMatch(/with qwen3:8b-16k on the model's server, a local model/)
    expect(text(away)).not.toMatch(/this computer/)
    const scripted = await h.call('slicerx_mimir_tab')
    expect(data<{ output: { link: string; where: unknown } }>(scripted).output).toMatchObject({ link: 'scripted', where: null })
    expect(text(scripted)).toMatch(/scripted replies: no model is set up/)
    const none = await h.call('slicerx_mimir_tab')
    expect(text(none)).toMatch(/has not been opened/)
  })

  it('says how to reach the app without sx-link', async () => {
    const demo = await connect({ printers: 'demo' })
    const off = await demo.call('slicerx_mimir_tab')
    expect(off.isError).toBe(true)
    expect(text(off)).toMatch(/--printers link/)
  })
})

describe('Vault designs through a scripted hub', () => {
  const link = (hub: ReturnType<typeof scriptedHub>) => ({ printers: 'link' as const, linkUrl: 'ws://127.0.0.1:47615', linkCode: 'AGNT-CODE', linkWebSocket: hub.WS })
  const design = (n: number, sizeMm: [number, number, number] | null) => ({
    id: `listing-${n}`,
    slug: `cable-clip-${n}`,
    title: `Cable clip ${n}`,
    creator: { handle: 'oddfellow', displayName: 'Odd Fellow' },
    license: 'cc-by',
    tags: ['functional'],
    status: 'approved',
    publishedAt: '2026-10-01T09:00:00.000Z',
    version: { version: '1.0.0', format: 'sx3mf', colors: [{ hex: '#ff5555', name: 'Red' }], sizeMm, print: { printer: 'Bambu Lab A1', timeS: 1800, grams: 9 } },
    stats: { downloads: 12, makes: 3, likes: 5 },
    liked: false,
    saved: n === 1,
  })
  const DESIGNS = [design(1, [42, 18.5, 12]), design(2, null), design(3, [60, 60, 4])]

  /** The app's side of vault.list: two designs a page, and the person's own lists only while signed in. */
  function vaultApp(signedIn: () => boolean) {
    return (method: string, args: Record<string, unknown>) => {
      if (method !== 'vault.list') throw { code: 'bad_request', message: `unknown method ${method}` }
      const list = (args['list'] as string | undefined) ?? 'all'
      if (list !== 'all' && !signedIn()) throw { code: 'signed_out', message: 'nobody is signed in to the Vault in SlicerX, so there is no Saved list to read; the person signs in from the Vault' }
      const items = list === 'saved' ? DESIGNS.filter((d) => d.saved) : DESIGNS
      const start = Number(args['cursor'] ?? 0)
      const end = start + ((args['limit'] as number | undefined) ?? 24)
      return { list, signedIn: signedIn(), items: items.slice(start, end), next: end < items.length ? String(end) : null }
    }
  }
  const calls = (hub: ReturnType<typeof scriptedHub>) => hub.sent().filter((s) => s.method === 'app.call').map((s) => s.params)

  it('lists designs with their size, null where the scan gave none, page by page', async () => {
    const hub = scriptedHub({ ok: true }, true, undefined, vaultApp(() => true))
    const h = await connect(link(hub))
    const listed = (await h.client.listTools()).tools.find((t) => t.name === 'slicerx_vault_list')
    expect(listed?.annotations?.readOnlyHint).toBe(true)
    const first = await h.call('slicerx_vault_list', { limit: 2 })
    expect(first.isError, text(first)).toBeFalsy()
    const page = data<{ output: { list: string; signedIn: boolean; items: { id: string; version: { sizeMm: unknown } }[]; next: string | null } }>(first).output
    expect(page).toMatchObject({ list: 'all', signedIn: true, next: '2' })
    expect(page.items.map((d) => d.version.sizeMm)).toEqual([[42, 18.5, 12], null])
    expect(page.items[0]).toEqual(DESIGNS[0])
    expect(text(first)).toContain('"summary":"2 designs in the SlicerX Vault, 1 with a size; more with cursor 2."')
    expect(calls(hub).at(-1)).toEqual({ method: 'vault.list', args: { limit: 2 } })
    const second = await h.call('slicerx_vault_list', { limit: 2, cursor: page.next })
    const rest = data<{ output: { items: { id: string; version: { sizeMm: unknown } }[]; next: string | null } }>(second).output
    expect(rest.items.map((d) => [d.id, d.version.sizeMm])).toEqual([['listing-3', [60, 60, 4]]])
    expect(rest.next).toBeNull()
    expect(calls(hub).at(-1)).toEqual({ method: 'vault.list', args: { limit: 2, cursor: '2' } })
  })

  it('answers signed_out for the person\'s own lists while nobody is signed in, and still reads the catalog', async () => {
    let signedIn = false
    const hub = scriptedHub({ ok: true }, true, undefined, vaultApp(() => signedIn))
    const h = await connect(link(hub))
    for (const list of ['saved', 'mine']) {
      const r = await h.call('slicerx_vault_list', { list })
      expect(r.isError, list).toBe(true)
      expect(data<{ error: { code: string } }>(r).error.code).toBe('signed_out')
      expect(text(r)).toMatch(/^Error: signed_out: nobody is signed in to the Vault in SlicerX/)
    }
    const all = await h.call('slicerx_vault_list', {})
    expect(all.isError, text(all)).toBeFalsy()
    expect(text(all)).toContain('"summary":"3 designs in the SlicerX Vault, 2 with a size (signed out)."')
    signedIn = true
    const saved = await h.call('slicerx_vault_list', { list: 'saved' })
    expect(data<{ output: { items: { id: string }[] } }>(saved).output.items.map((d) => d.id)).toEqual(['listing-1'])
    expect(text(saved)).toContain('"summary":"1 design on the Saved list in SlicerX, 1 with a size."')
  })

  it('checks the input before anything reaches the app', async () => {
    const hub = scriptedHub({ ok: true }, true, undefined, vaultApp(() => true))
    const h = await connect(link(hub))
    for (const bad of [{ list: 'saved', sort: 'popular' }, { list: 'liked' }, { limit: 0 }, { limit: 51 }, { cursor: 'next' }, { query: '' }]) {
      const r = await h.call('slicerx_vault_list', bad)
      expect(r.isError, JSON.stringify(bad)).toBe(true)
      expect(text(r), JSON.stringify(bad)).toMatch(/^Input validation error: Invalid arguments for tool slicerx_vault_list/)
    }
    expect(calls(hub)).toEqual([])
  })

  it('says how to reach the app while the link is off, or without sx-link', async () => {
    const h = await connect(link(scriptedHub({ ok: true })))
    const r = await h.call('slicerx_vault_list', {})
    expect(r.isError).toBe(true)
    expect(data<{ error: { code: string } }>(r).error.code).toBe('not_configured')
    const demo = await connect({ printers: 'demo' })
    const off = await demo.call('slicerx_vault_list', {})
    expect(text(off)).toMatch(/^Error: not_configured: .*--printers link/)
  })
})

// The printer line tools are person only, so a person approves them in the app and the hub sends the line
// under its own rules (home under the home rules). Their in-process run sends nothing, whatever token it gets.
describe('printer line tools never send in process', () => {
  it.each([
    ['printer.home', { printerId: 'bay-4' }],
    ['printer.gcode', { printerId: 'bay-4', line: 'G28' }],
    ['printer.set_temperature', { printerId: 'bay-4', heater: 'bed', celsius: 60 }],
    ['printer.filament', { printerId: 'bay-4', action: 'load' }],
    ['printer.filament_change', { printerId: 'bay-4' }],
  ] as const)('%s', async (name, input) => {
    const { localTools } = await import('../src/tools')
    const tool = localTools({} as never).find((t) => t.name === name)
    if (!tool) throw new Error(`no ${name}`)
    const calls: string[] = []
    const printers = {
      list: async () => [{ id: 'bay-4', plugin: 'moonraker' }],
      status: async () => ({ state: 'idle' }),
      sendGcode: async (_id: string, line: string) => void calls.push(line),
      callTool: async (_p: string, _t: string, a: { line: string }) => void calls.push(a.line),
    }
    const token = { requestId: 'r-1', token: 't', expiresAt: '2099-01-01T00:00:00.000Z' }
    const out = await (tool as { run(i: unknown, c: unknown): Promise<{ ok?: boolean; summary: string }> }).run(input, { token, host: { printers } })
    expect(out.ok).toBe(false)
    expect(out.summary).toMatch(/approve/i)
    expect(calls).toEqual([])
  })
})
