// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A WebSocket stand-in for sx-link: it proves the hub key in `hello`, runs the code exchange for the agent code, and
// hands every other request to the test's handler. A handler that throws `{code, message}` answers with that error.
import { base64ToBytes, bytesToBase64, pakeAnswer } from '@slicerx/link-client'

export type HubHandler = (method: string, params: Record<string, unknown>) => unknown

export const AGENT_CODE = 'AGNT-CODE'
const CODES = { app: 'APPS-CODE', agent: AGENT_CODE, watch: 'WTCH-CODE' }
const PORT = 47615
const HELLO_CONTEXT = new TextEncoder().encode('sx-link hello v2\n')

class FakeSocket {
  static OPEN = 1
  readyState = 1
  binaryType = 'blob'
  private listeners = new Map<string, ((e: unknown) => void)[]>()
  constructor(private readonly answer: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
    queueMicrotask(() => this.fire('open', {}))
  }
  addEventListener(type: string, cb: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb])
  }
  removeEventListener() {}
  fire(type: string, e: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb(e)
  }
  send(raw: string) {
    const { id, method, params } = JSON.parse(raw) as { id: number; method: string; params?: Record<string, unknown> }
    void this.answer(method, params ?? {}).then(
      (result) => this.fire('message', { data: JSON.stringify({ id, result }) }),
      (e: { code?: string; message?: string }) => this.fire('message', { data: JSON.stringify({ id, error: { code: e.code ?? 'protocol', message: e.message ?? 'failed' } }) }),
    )
  }
  close() {
    this.readyState = 3
    this.fire('close', {})
  }
}

/** The hub and the methods the server sent it, in order (hello and pair left out). */
export function scriptedLinkHub(handler: HubHandler): { WS: typeof WebSocket; sent: { method: string; params: Record<string, unknown> }[] } {
  const sent: { method: string; params: Record<string, unknown> }[] = []
  const keys = crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as Promise<CryptoKeyPair>
  const WS = class extends FakeSocket {
    constructor() {
      let ctx: Parameters<typeof pakeAnswer>[1] | undefined
      let run: ReturnType<typeof pakeAnswer> = null
      super(async (method, params) => {
        if (method === 'hello') {
          // An Ed25519 signature over both nonces and the port, as a real hub signs it.
          const k = await keys
          const clientNonce = new Uint8Array(Buffer.from(String(params['nonce']), 'base64'))
          const hubNonce = crypto.getRandomValues(new Uint8Array(32))
          const sig = await crypto.subtle.sign({ name: 'Ed25519' }, k.privateKey, Buffer.concat([HELLO_CONTEXT, clientNonce, hubNonce, Buffer.from([(PORT >> 8) & 0xff, PORT & 0xff])]))
          const hubKey = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey))
          ctx = { hubKey, port: PORT, clientNonce, hubNonce }
          return { hubKey: bytesToBase64(hubKey), hubNonce: bytesToBase64(hubNonce), port: PORT, sig: Buffer.from(sig).toString('base64') }
        }
        if (method === 'pair') {
          if (!ctx) throw { code: 'unauthorized', message: 'no hello' }
          if (typeof params['pake'] === 'string') {
            run = pakeAnswer(CODES, ctx, base64ToBytes(params['pake']), () => crypto.getRandomValues(new Uint8Array(32)))
            return { pake: Object.fromEntries(Object.entries(run?.yb ?? {}).map(([r, m]) => [r, bytesToBase64(m)])) }
          }
          const tags = Object.fromEntries(Object.entries((params['confirm'] ?? {}) as Record<string, string>).map(([r, t]) => [r, base64ToBytes(t)]))
          const ok = run?.check(tags)
          run = null
          if (!ok) throw { code: 'unauthorized', message: 'wrong pairing code' }
          return { paired: true, role: ok.role, confirm: bytesToBase64(ok.confirm) }
        }
        sent.push({ method, params })
        if (method === 'plugins') return []
        return handler(method, params) ?? {}
      })
    }
  }
  return { WS: WS as unknown as typeof WebSocket, sent }
}
