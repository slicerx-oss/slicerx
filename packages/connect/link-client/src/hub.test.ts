// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The client against a scripted hub: it checks the hub's key before it sends a code, and it
// carries agent work and its outcome. No sx-link binary needed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bytesToBase64, base64ToBytes, connectLink, LinkError, pakeAnswer } from './index.ts'

const CODES = { app: 'APPS-CODE', agent: 'AGNT-CODE', watch: 'WTCH-CODE' }

const CONTEXT = new TextEncoder().encode('sx-link hello v2\n')

type Handler = (method: string, params: Record<string, unknown>, sock: FakeSocket) => Promise<unknown> | unknown

/** A WebSocket stand-in that answers requests with `handler` and records what the client sent. */
class FakeSocket {
  static OPEN = 1
  readyState = 1
  binaryType = 'blob'
  sent: { method: string; params: Record<string, unknown> }[] = []
  private listeners = new Map<string, ((e: unknown) => void)[]>()
  readonly handler: Handler
  constructor(handler: Handler) {
    this.handler = handler
    queueMicrotask(() => this.fire('open', {}))
  }
  addEventListener(type: string, cb: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb])
  }
  fire(type: string, e: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb(e)
  }
  event(body: unknown) {
    this.fire('message', { data: JSON.stringify(body) })
  }
  send(text: string) {
    const { id, method, params } = JSON.parse(text) as { id: number; method: string; params: Record<string, unknown> }
    this.sent.push({ method, params })
    void Promise.resolve(this.handler(method, params, this)).then(
      (result) => this.event({ id, result }),
      (e: { code?: string; message?: string }) => this.event({ id, error: { code: e.code ?? 'protocol', message: e.message ?? 'failed' } }),
    )
  }
  close() {
    this.readyState = 3
    this.fire('close', {})
  }
}

async function hubKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const pub = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  /** Signs a hello for `port`; returns the reply a hub sends. */
  const hello = async (nonceB64: string, port: number) => {
    const nonce = base64ToBytes(nonceB64)
    const hubNonce = crypto.getRandomValues(new Uint8Array(32))
    const msg = new Uint8Array(CONTEXT.length + nonce.length + 32 + 2)
    msg.set(CONTEXT)
    msg.set(nonce, CONTEXT.length)
    msg.set(hubNonce, CONTEXT.length + nonce.length)
    msg.set([port >> 8, port & 0xff], CONTEXT.length + nonce.length + 32)
    const sig = bytesToBase64(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, msg)))
    return { reply: { hubKey: pub, hubNonce: bytesToBase64(hubNonce), port, sig }, nonce, hubNonce }
  }
  return { pub, hello }
}

type Keys = Awaited<ReturnType<typeof hubKeys>>

/** A fake hub. `port` is the port it signs (47615 unless it relays another hub's answer). */
function hubWith(keys: Keys, extra: Handler = () => ({}), o: { port?: number; replyKey?: string; codes?: Partial<typeof CODES> } = {}) {
  let sock: FakeSocket | undefined
  let last: { nonce: Uint8Array; hubNonce: Uint8Array } | undefined
  let run: ReturnType<typeof pakeAnswer> = null
  const WS = class extends FakeSocket {
    constructor() {
      super(async (method, params, s) => {
        if (method === 'hello') {
          const h = await keys.hello(String(params['nonce']), o.port ?? 47615)
          last = { nonce: h.nonce, hubNonce: h.hubNonce }
          return o.replyKey ? { ...h.reply, hubKey: o.replyKey } : h.reply
        }
        if (method === 'pair') {
          if (typeof params['clientKey'] === 'string') return extra(method, params, s)
          if (!last) throw Object.assign(new Error('no hello'), { code: 'unauthorized' })
          if (typeof params['pake'] === 'string') {
            const ctx = { hubKey: base64ToBytes(keys.pub), port: o.port ?? 47615, clientNonce: last.nonce, hubNonce: last.hubNonce }
            run = pakeAnswer(o.codes ?? CODES, ctx, base64ToBytes(params['pake']), () => crypto.getRandomValues(new Uint8Array(32)))
            if (!run) throw Object.assign(new Error('bad message'), { code: 'bad_request' })
            return { pake: Object.fromEntries(Object.entries(run.yb).map(([r, m]) => [r, bytesToBase64(m)])) }
          }
          const tags = Object.fromEntries(Object.entries((params['confirm'] ?? {}) as Record<string, string>).map(([r, t]) => [r, base64ToBytes(t)]))
          const ok = run?.check(tags)
          run = null
          if (!ok) throw Object.assign(new Error('wrong pairing code'), { code: 'unauthorized' })
          return { paired: true, role: ok.role, confirm: bytesToBase64(ok.confirm) }
        }
        return extra(method, params, s)
      })
      sock = this
    }
  }
  return { WS: WS as unknown as typeof WebSocket, sent: () => sock?.sent ?? [], sock: () => sock }
}

test('a pinned hub key is checked before the code exchange, and the code is never sent', async () => {
  const real = await hubKeys()
  const squatter = await hubKeys()
  const ok = hubWith(real)
  const host = await connectLink({ code: 'AGNT-CODE', hubKey: real.pub, WebSocket: ok.WS })
  assert.equal(host.hubKey, real.pub)
  assert.deepEqual(ok.sent().map((s) => s.method), ['hello', 'pair', 'pair'])
  assert.ok(!JSON.stringify(ok.sent()).includes('AGNT'), 'the code is never sent')

  // Something else on the port, with its own key: nothing secret is sent.
  const bad = hubWith(squatter)
  // R10: the error names the key that signed this connection, so the app can show its fingerprint.
  await assert.rejects(connectLink({ code: 'AGNT-CODE', hubKey: real.pub, WebSocket: bad.WS }), (e: unknown) => e instanceof LinkError && e.code === 'hub_identity' && e.presentedKey === squatter.pub)
  assert.deepEqual(bad.sent().map((s) => s.method), ['hello'])

  // A squatter that names the real key cannot sign for it.
  const replay = hubWith(squatter, undefined, { replyKey: real.pub })
  await assert.rejects(connectLink({ code: 'AGNT-CODE', hubKey: real.pub, WebSocket: replay.WS }), (e: unknown) => e instanceof LinkError && e.code === 'hub_identity' && e.presentedKey === undefined)
  assert.deepEqual(replay.sent().map((s) => s.method), ['hello'])

  // A program on 47615 relaying the real hub's answer from another port: the signed port gives it away.
  const relay = hubWith(real, undefined, { port: 47999 })
  await assert.rejects(connectLink({ code: 'AGNT-CODE', hubKey: real.pub, WebSocket: relay.WS }), (e: unknown) => e instanceof LinkError && e.code === 'hub_identity')
  assert.deepEqual(relay.sent().map((s) => s.method), ['hello'])
})

test('a program that will not answer hello gets no code, even with nothing pinned (N9)', async () => {
  let sent: { method: string }[] = []
  const WS = class extends FakeSocket {
    constructor() {
      super(async (method) => {
        if (method === 'hello') throw Object.assign(new Error('unknown method'), { code: 'bad_request' })
        return { paired: true, role: 'app' }
      })
      sent = this.sent
    }
  }
  await assert.rejects(connectLink({ code: 'AGNT-CODE', WebSocket: WS as unknown as typeof WebSocket }), (e: unknown) => e instanceof LinkError && e.code === 'hub_identity')
  assert.deepEqual(sent.map((s) => s.method), ['hello'])
  assert.ok(!JSON.stringify(sent).includes('AGNT'))
})

test('a saved client key goes only to a hub that proves the pinned key', async () => {
  const real = await hubKeys()
  const squatter = await hubKeys()
  const key = 'k'.repeat(64)
  // Nothing pinned: a program that signs its own hello would get a key that works on the real hub.
  const open = hubWith(squatter)
  await assert.rejects(connectLink({ clientKey: key, WebSocket: open.WS }), (e: unknown) => e instanceof LinkError && e.code === 'hub_identity')
  assert.deepEqual(open.sent(), [], 'not even a hello')
  // Pinned, but something else answers: the key stays here.
  const bad = hubWith(squatter)
  await assert.rejects(connectLink({ clientKey: key, hubKey: real.pub, WebSocket: bad.WS }), (e: unknown) => e instanceof LinkError && e.code === 'hub_identity')
  assert.ok(!JSON.stringify(bad.sent()).includes(key))
  // The pinned hub gets it.
  const ok = hubWith(real, (method, params) => (method === 'pair' && params['clientKey'] === key ? { paired: true, role: 'agent' } : {}))
  const host = await connectLink({ clientKey: key, hubKey: real.pub, WebSocket: ok.WS })
  assert.equal(host.hubKey, real.pub)
  assert.deepEqual(ok.sent().map((s) => s.method), ['hello', 'pair'])
})

test('without a pinned key the client reports the key to pin', async () => {
  const real = await hubKeys()
  const h = hubWith(real)
  const host = await connectLink({ code: 'AGNT-CODE', WebSocket: h.WS })
  assert.equal(host.hubKey, real.pub)
})

test('N9: a squatter at the first pairing gets one wrong guess and nothing to test offline', async () => {
  // Nothing pinned: the squatter signs its own hello and runs the exchange with codes it guessed.
  const squatter = await hubKeys()
  const h = hubWith(squatter, undefined, { codes: { app: 'GUES-SONE', agent: 'GUES-STWO', watch: 'GUES-STHR' } })
  await assert.rejects(connectLink({ code: 'AGNT-CODE', WebSocket: h.WS }), (e: unknown) => e instanceof LinkError && e.code === 'unauthorized')
  // What it received is a CPace message and three tags, none keyed by the code alone.
  assert.deepEqual(h.sent().map((s) => s.method), ['hello', 'pair', 'pair'])
  assert.ok(!JSON.stringify(h.sent()).includes('AGNT'))
  assert.equal(h.sent()[1]?.params['proof'], undefined)
})

test('an older hub that predates the exchange is named, not trusted', async () => {
  const real = await hubKeys()
  const WS = class extends FakeSocket {
    constructor() {
      super(async (method, params) => {
        if (method === 'hello') return (await real.hello(String(params['nonce']), 47615)).reply
        // A version 1 hub reads `pake` as a pair with no code.
        throw Object.assign(new Error('wrong pairing code'), { code: 'unauthorized' })
      })
    }
  }
  await assert.rejects(connectLink({ code: 'AGNT-CODE', WebSocket: WS as unknown as typeof WebSocket }), (e: unknown) => e instanceof LinkError && /Update SlicerX/.test(e.message))
})

test('a hub that cannot confirm the exchange is refused', async () => {
  const real = await hubKeys()
  let run: ReturnType<typeof pakeAnswer> = null
  let last: { nonce: Uint8Array; hubNonce: Uint8Array } | undefined
  const WS = class extends FakeSocket {
    constructor() {
      super(async (method, params) => {
        if (method === 'hello') {
          const h = await real.hello(String(params['nonce']), 47615)
          last = { nonce: h.nonce, hubNonce: h.hubNonce }
          return h.reply
        }
        if (params['pake'] && last) {
          run = pakeAnswer(CODES, { hubKey: base64ToBytes(real.pub), port: 47615, clientNonce: last.nonce, hubNonce: last.hubNonce }, base64ToBytes(String(params['pake'])), () => crypto.getRandomValues(new Uint8Array(32)))
          return { pake: Object.fromEntries(Object.entries(run?.yb ?? {}).map(([r, m]) => [r, bytesToBase64(m)])) }
        }
        // Says yes without the hub's half of the confirmation.
        return { paired: true, role: 'agent', confirm: bytesToBase64(new Uint8Array(32)) }
      })
    }
  }
  await assert.rejects(connectLink({ code: 'AGNT-CODE', WebSocket: WS as unknown as typeof WebSocket }), (e: unknown) => e instanceof LinkError && e.code === 'hub_identity')
})

test('agent work is registered with the card and its outcome arrives as approval.done', async () => {
  const real = await hubKeys()
  const h = hubWith(real, (method, _params, sock) => {
    if (method === 'approvals.register') {
      setTimeout(() => sock.event({ event: 'approval.done', data: { requestId: 'mcp-1', printerId: 'bay-4', ok: true } }), 5)
      return { registered: true, answeredIn: 'app' }
    }
    return {}
  })
  const host = await connectLink({ code: 'AGNT-CODE', role: 'agent', WebSocket: h.WS })
  const done = new Promise((resolve) => host.onApprovalDone(resolve))
  const data = new TextEncoder().encode('G28\n')
  const file = { name: 'cube.gcode', kind: 'gcode' as const, data: data.buffer, sha256: 'ab'.repeat(32) }
  const request = { id: 'mcp-1', sessionId: 's', tool: 'printer.queue', permission: 'start', title: 'Print cube.gcode', lines: [], paramsHash: '0'.repeat(64), actions: [], expiresAt: '2099-01-01T00:00:00.000Z' }
  const r = await host.approvals.registerWork(request as never, { kind: 'print', printerId: 'bay-4', file })
  assert.equal(r.answeredIn, 'app')
  const sent = h.sent().find((s) => s.method === 'approvals.register')
  const work = sent?.params['work'] as { file: { dataBase64: string; name: string } }
  assert.equal(work.file.name, 'cube.gcode')
  assert.equal(work.file.dataBase64, bytesToBase64(data))
  assert.deepEqual(await done, { requestId: 'mcp-1', printerId: 'bay-4', ok: true })
  assert.equal(h.sent().find((s) => s.method === 'pair' && s.params['confirm'])?.params['role'], 'agent')
})

test('the app makes an agent key through clients.create', async () => {
  const real = await hubKeys()
  const h = hubWith(real, (method, params) => {
    if (method === 'clients.create') return { clientId: 'client-1', clientKey: 'k'.repeat(64), role: params['role'] }
    return {}
  })
  const host = await connectLink({ code: 'AGNT-CODE', WebSocket: h.WS })
  const r = await host.clients.create('ChatGPT', 'agent')
  assert.deepEqual(r, { clientId: 'client-1', clientKey: 'k'.repeat(64), role: 'agent' })
  assert.deepEqual(h.sent().find((s) => s.method === 'clients.create')?.params, { name: 'ChatGPT', role: 'agent' })
})
