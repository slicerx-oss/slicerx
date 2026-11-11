// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Node-only pieces: the LLM transport for evals and CLI runs (the Node twin
// of sx-llm) and a JSONL session store. Not for the browser bundle.
import { execFile, spawn } from 'node:child_process'
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { LlmHttpRequest, LlmTransport, PilotEvent, SessionStore } from '@slicerx/contracts'
import { geomCallLimitMs, geomStuckMessage } from '@slicerx/contracts/geom-limits'
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
 * A geometry call's time limit: one for every operation, or one by operation. By default each operation's class limit
 * (@slicerx/contracts geom-limits.ts).
 */
export type GeomTimeout = number | ((op: string) => number)

const limitFor = (timeout: GeomTimeout | undefined, op: string): number => (typeof timeout === 'number' ? timeout : (timeout ?? geomCallLimitMs)(op))

/**
 * Geometry through the `sx-geom` command: the request JSON goes to stdin, the
 * response comes back on stdout. `binary` defaults to `sx-geom` on PATH; `args`
 * go before the operation's name (a script run by an interpreter). A call past
 * its time limit (`timeoutMs`) is stopped and refused with what to try.
 */
export function createGeomCli(opts: { binary?: string; args?: readonly string[]; timeoutMs?: GeomTimeout } = {}): GeomHost {
  const bin = opts.binary ?? 'sx-geom'
  return {
    run(op, input, signal) {
      if (!/^[a-z.]+$/.test(op)) return Promise.reject(new Error(`Bad geometry operation ${op}`))
      return new Promise((resolve, reject) => {
        const child = spawn(bin, [...(opts.args ?? []), op], { stdio: ['pipe', 'pipe', 'pipe'], ...(signal ? { signal } : {}) })
        const out: Buffer[] = []
        const err: Buffer[] = []
        const ms = limitFor(opts.timeoutMs, op)
        let late = false
        const timer = setTimeout(() => {
          late = true
          child.kill('SIGKILL')
        }, ms)
        child.stdout.on('data', (d: Buffer) => out.push(d))
        child.stderr.on('data', (d: Buffer) => err.push(d))
        child.on('error', (e) => {
          clearTimeout(timer)
          reject(e)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (late) {
            reject(new Error(`sx-geom ${op}: ${geomStuckMessage(op, ms)}`))
            return
          }
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

/**
 * What a trapped engine call says. A panic aborts the web build, which traps as `unreachable`; the engine keeps the
 * panic's message and place (`geom_panic_ptr`). A trap with no panic kept is an allocation the host refused: the
 * module's memory could not grow.
 */
export function trapMessage(panic: string, memoryBytes: number): string {
  if (panic) return `the engine stopped on an internal error: ${panic.replace(/\s+/g, ' ').trim()}`
  return `the engine ran out of memory at ${(memoryBytes / 2 ** 20).toFixed(1)} MB; try the step again`
}

/** Runs in the engine's worker thread: one request in, its reply text or error out. */
const ENGINE_THREAD = `
const { parentPort, workerData } = require('node:worker_threads')
const x = new WebAssembly.Instance(new WebAssembly.Module(require('node:fs').readFileSync(workerData.wasm)), {}).exports
const text = (ptr, len) => new TextDecoder().decode(new Uint8Array(x.memory.buffer, ptr, len))
parentPort.on('message', ({ op, input }) => {
  let code
  try {
    const bytes = new TextEncoder().encode(op + '\\0' + JSON.stringify(input))
    const at = x.geom_input(bytes.length)
    new Uint8Array(x.memory.buffer, at, bytes.length).set(bytes)
    code = x.geom_call()
  } catch (e) {
    if (!(e instanceof WebAssembly.RuntimeError)) throw e
    // the host ends this worker, so the next call gets a fresh engine
    parentPort.postMessage({ trap: { panic: x.geom_panic_len ? text(x.geom_panic_ptr(), x.geom_panic_len()) : '', memoryBytes: x.memory.buffer.byteLength } })
    return
  }
  if (code === 0) parentPort.postMessage({ out: text(x.geom_out_ptr(), x.geom_out_len()) })
  else parentPort.postMessage({ error: text(x.geom_error_ptr(), x.geom_error_len()) })
})
`

/**
 * Geometry through the sx-geom web build (packages/geom/wasm), in a worker thread of this process. Its replies match
 * the command's byte for byte; errors read like the command's, `sx-geom <op>: <message>`. A call that is canceled or
 * runs past its time limit (`timeoutMs`, by default its operation's class limit) ends its worker, since a synchronous
 * engine call reads no messages, and the next call starts a fresh one; one past its limit is refused with what to try.
 * Calls run one at a time, in order, and each one's limit starts when its turn comes. A call that traps ends its worker
 * too, since a trapped module is left as it stopped, and says why (trapMessage).
 */
export function createGeomWasm(opts: { wasm: string; timeoutMs?: GeomTimeout }): GeomHost {
  let worker: Worker | null = null
  let queue: Promise<unknown> = Promise.resolve()
  const call = (op: string, input: unknown, signal?: AbortSignal): Promise<unknown> => {
    signal?.throwIfAborted()
    const w = (worker ??= new Worker(ENGINE_THREAD, { eval: true, workerData: { wasm: opts.wasm } }))
    // the call's own timer keeps the process alive meanwhile; an idle worker does not
    w.unref()
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        w.off('message', onMessage).off('error', onError).off('exit', onExit)
      }
      const fail = (message: string): void => {
        done()
        reject(new Error(`sx-geom ${op}: ${message}`))
      }
      const stop = (message: string): void => {
        if (worker === w) worker = null
        void w.terminate()
        fail(message)
      }
      const onAbort = (): void => stop('canceled, so the engine was stopped')
      const onMessage = (m: { out?: string; error?: string; trap?: { panic: string; memoryBytes: number } }): void => {
        if (m.trap) {
          stop(trapMessage(m.trap.panic, m.trap.memoryBytes))
          return
        }
        if (m.out !== undefined) {
          // read before settling: a throw in this listener would leave the call, and every call queued behind it, waiting
          let value: unknown
          try {
            value = JSON.parse(m.out)
          } catch {
            fail('unreadable reply')
            return
          }
          done()
          resolve(value)
          return
        }
        let message = m.error ?? 'no reply'
        try {
          message = (JSON.parse(message) as { error?: string }).error ?? message
        } catch {
          // A plain message stays as it is.
        }
        fail(message)
      }
      const onError = (e: Error): void => stop(e.message)
      const onExit = (code: number): void => {
        if (worker === w) worker = null
        fail(`the engine stopped (exit ${code})`)
      }
      const ms = limitFor(opts.timeoutMs, op)
      const timer = setTimeout(() => stop(geomStuckMessage(op, ms)), ms)
      signal?.addEventListener('abort', onAbort, { once: true })
      w.on('message', onMessage).on('error', onError).on('exit', onExit)
      w.postMessage({ op, input })
    })
  }
  return {
    run(op, input, signal) {
      const next = (): Promise<unknown> => call(op, input, signal)
      const answer = queue.then(next, next)
      queue = answer.catch(() => undefined)
      return answer
    },
  }
}
