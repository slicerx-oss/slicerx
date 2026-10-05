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

function scriptedHub(outcome: { ok: boolean; message?: string }, proves = true) {
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
            return [printer]
          case 'status':
            return status
          case 'approvals.register': {
            const req = params['request'] as { id: string }
            // A person approves in the app a moment later; the hub runs the work and reports.
            setTimeout(() => s.event({ event: 'approval.done', data: { requestId: req.id, printerId: 'bay-4', ...outcome } }), 20)
            return { registered: true, answeredIn: 'app' }
          }
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
})
