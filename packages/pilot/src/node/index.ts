// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Node-only pieces: the LLM transport for evals and CLI runs (the Node twin
// of sx-llm) and a JSONL session store. Not for the browser bundle.
import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LlmHttpRequest, LlmTransport, PilotEvent, SessionStore } from '@slicerx/contracts'
import type { GeomHost } from '../hosts'
import { scrub, summarize } from '../session'

const KEYCHAIN = { service: 'slicerx-openai-api-key', account: 'slicerx' }
/** The variables the anthropic route reads its key from, first set wins; the same names the desktop transport reads. */
export const ANTHROPIC_KEY_ENV = ['SLICERX_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'] as const
/** The Messages API version the desktop and browser transports send. */
const ANTHROPIC_VERSION = '2023-06-01'
const ALLOWED_HOSTS: Record<string, (u: URL) => boolean> = {
  openai: (u) => u.protocol === 'https:' && u.hostname === 'api.openai.com',
  anthropic: (u) => u.protocol === 'https:' && u.hostname === 'api.anthropic.com' && u.port === '',
  'openai-compatible': (u) => u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'),
}

function keychainKey(): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', KEYCHAIN.service, '-a', KEYCHAIN.account, '-w'], { timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null)
    })
  })
}

/**
 * Reads the key at request time. openai: SLICERX_OPENAI_API_KEY, OPENAI_API_KEY, then
 * the macOS Keychain. anthropic: the ANTHROPIC_KEY_ENV variables only. The value lives
 * only in this call's scope; it is never cached, logged or put in an error.
 */
async function readKey(provider: string): Promise<string | null> {
  if (provider === 'openai-compatible') return 'local'
  // a value with spaces or control characters inside (two pasted lines) counts as missing, so no header error can quote it
  if (provider === 'anthropic') return ANTHROPIC_KEY_ENV.map((n) => process.env[n]?.trim()).find((v) => v && /^[!-~]+$/.test(v)) ?? null
  if (provider !== 'openai') return null
  return process.env['SLICERX_OPENAI_API_KEY'] || process.env['OPENAI_API_KEY'] || (await keychainKey())
}

/** `key` is the value that was sent, so an error body that quotes it back loses it too. */
function redact(s: string, key: string | null): string {
  return (key ? s.split(key).join('[key]') : s).replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-...').replace(/Bearer\s+\S+/gi, 'Bearer ...')
}

/** Headers the transport sets itself; a request that brings one is refused. */
const OWN_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'anthropic-version'])

/** Says where the key goes and nothing else: no value, no request. */
function missingKey(provider: string): string {
  if (provider === 'anthropic') return `No API key for anthropic: set ${ANTHROPIC_KEY_ENV[1]} (or ${ANTHROPIC_KEY_ENV[0]})`
  return `No API key for ${provider}: set OPENAI_API_KEY or add the Keychain item ${KEYCHAIN.service}`
}

export class TransportError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'TransportError'
    this.status = status
  }
}

export interface NodeTransportOptions {
  /** Counts every provider request; the eval runner stops at a budget. */
  onRequest?(req: LlmHttpRequest): void
}

export function createNodeTransport(opts: NodeTransportOptions = {}): LlmTransport {
  return {
    async available(provider) {
      return (await readKey(provider)) !== null
    },
    async *stream(req, signal) {
      const url = new URL(req.url)
      const allowed = ALLOWED_HOSTS[req.provider]
      if (!allowed?.(url)) throw new TransportError(0, `Refusing to send a ${req.provider} request to ${url.host}`)
      if (Object.keys(req.headers).some((h) => OWN_HEADERS.has(h.toLowerCase()))) throw new TransportError(0, 'Requests must not carry their own authorization header')
      const key = await readKey(req.provider)
      if (!key) throw new TransportError(401, missingKey(req.provider))
      opts.onRequest?.(req)
      const auth = req.provider === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION } : { authorization: `Bearer ${key}` }
      // never follow a redirect: fetch keeps a custom key header on a cross-origin one, so the key could leave the allowed host
      const init: RequestInit = { method: req.method, headers: { ...req.headers, ...auth }, body: req.body, redirect: 'error' }
      if (signal) init.signal = signal
      const secret = req.provider === 'openai-compatible' ? null : key
      let res: Response
      try {
        res = await fetch(req.url, init)
      } catch (e) {
        if (signal?.aborted) throw e
        const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : ''
        throw new TransportError(0, `${req.provider} request failed: ${redact(`${e instanceof Error ? e.message : String(e)}${cause}`, secret).slice(0, 300)}`)
      }
      if (!res.ok || !res.body) {
        let msg = res.statusText
        try {
          const j = (await res.json()) as { error?: { message?: string } }
          if (j.error?.message) msg = j.error.message
        } catch {
          // Non-JSON error bodies keep the status text.
        }
        throw new TransportError(res.status, `${req.provider} ${res.status}: ${redact(msg, secret).slice(0, 300)}`)
      }
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) yield value
      }
    },
  }
}

/** One JSONL file per session under `dir`. */
export function createFileSessionStore(dir: string): SessionStore {
  const file = (id: string): string => join(dir, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`)
  return {
    async append(sessionId, event) {
      await mkdir(dir, { recursive: true })
      await appendFile(file(sessionId), `${JSON.stringify(scrub(event))}\n`)
    },
    async read(sessionId) {
      const text = await readFile(file(sessionId), 'utf8').catch(() => '')
      return text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as PilotEvent)
    },
    async list() {
      const names = await readdir(dir).catch(() => [])
      const out = []
      for (const n of names.filter((x) => x.endsWith('.jsonl'))) {
        const id = n.slice(0, -6)
        out.push(summarize(id, await this.read(id)))
      }
      return out
    },
  }
}

/**
 * Geometry through the `sx-geom` command: the request JSON goes to stdin, the
 * response comes back on stdout. `binary` defaults to `sx-geom` on PATH.
 */
export function createGeomCli(opts: { binary?: string; timeoutMs?: number } = {}): GeomHost {
  const bin = opts.binary ?? 'sx-geom'
  return {
    run(op, input, signal) {
      if (!/^[a-z.]+$/.test(op)) return Promise.reject(new Error(`Bad geometry operation ${op}`))
      return new Promise((resolve, reject) => {
        const child = spawn(bin, [op], { stdio: ['pipe', 'pipe', 'pipe'], ...(signal ? { signal } : {}) })
        const out: Buffer[] = []
        const err: Buffer[] = []
        const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 60_000)
        child.stdout.on('data', (d: Buffer) => out.push(d))
        child.stderr.on('data', (d: Buffer) => err.push(d))
        child.on('error', (e) => {
          clearTimeout(timer)
          reject(e)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          const text = Buffer.concat(out).toString('utf8')
          let body: unknown
          try {
            body = JSON.parse(text)
          } catch {
            reject(new Error(`sx-geom ${op} returned no JSON (exit ${String(code)}): ${Buffer.concat(err).toString('utf8').slice(0, 200)}`))
            return
          }
          const e = body && typeof body === 'object' ? (body as Record<string, unknown>)['error'] : undefined
          if (code !== 0 || typeof e === 'string') reject(new Error(`sx-geom ${op}: ${typeof e === 'string' ? e : `exit ${String(code)}`}`))
          else resolve(body)
        })
        child.stdin.end(JSON.stringify(input))
      })
    },
  }
}

interface GeomWasmExports {
  memory: WebAssembly.Memory
  geom_input(len: number): number
  geom_call(): number
  geom_out_ptr(): number
  geom_out_len(): number
  geom_error_ptr(): number
  geom_error_len(): number
}

/**
 * Geometry through the sx-geom web build (packages/geom/wasm), in this process. Its replies match the
 * command's byte for byte; errors read like the command's, `sx-geom <op>: <message>`.
 */
export function createGeomWasm(opts: { wasm: string }): GeomHost {
  let exports: GeomWasmExports | null = null
  const load = (): GeomWasmExports => {
    if (!exports) exports = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(opts.wasm)), {}).exports as unknown as GeomWasmExports
    return exports
  }
  return {
    async run(op, input, signal) {
      signal?.throwIfAborted()
      const x = load()
      const text = (ptr: number, len: number) => new TextDecoder().decode(new Uint8Array(x.memory.buffer, ptr, len))
      const bytes = new TextEncoder().encode(`${op}\0${JSON.stringify(input)}`)
      const at = x.geom_input(bytes.length)
      new Uint8Array(x.memory.buffer, at, bytes.length).set(bytes)
      if (x.geom_call() === 0) return JSON.parse(text(x.geom_out_ptr(), x.geom_out_len())) as unknown
      let message = text(x.geom_error_ptr(), x.geom_error_len())
      try {
        message = (JSON.parse(message) as { error?: string }).error ?? message
      } catch {
        // A plain message stays as it is.
      }
      throw new Error(`sx-geom ${op}: ${message}`)
    },
  }
}
