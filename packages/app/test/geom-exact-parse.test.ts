// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The wasm engine reads long decimals as the native engine does, and as JSON.parse does: correctly rounded. It answers
// the recorded bracket calls in packages/geom/tests/fixtures/exact-parse-requests.json.gz with the same digest over
// every number of each reply as packages/geom/tests/exact_parse.rs records, and keeps the saved corner radius's bits.
// Each request goes to the engine as its recorded text, byte for byte. Runs where the engine is built, as the web job
// builds it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { liveEngine, wasmPath } from './geom-engine'

const fixtures = join(__dirname, '..', '..', 'geom', 'tests', 'fixtures')
const record = JSON.parse(readFileSync(join(fixtures, 'exact-parse.json'), 'utf8')) as {
  saved: { case: string; text: string; bits: string; reply: string }
  replies: Record<string, { numbers: number; digest: string }>
}
const requests = JSON.parse(gunzipSync(readFileSync(join(fixtures, 'exact-parse-requests.json.gz'))).toString('utf8')) as { case: string; op: string; text: string }[]

interface GeomExports {
  memory: WebAssembly.Memory
  geom_input(len: number): number
  geom_call(): number
  geom_out_ptr(): number
  geom_out_len(): number
  geom_error_ptr(): number
  geom_error_len(): number
}

/** The engine module, called with a request's text as it is (the shared provider writes the request again). */
async function rawGeom(): Promise<(op: string, text: string) => string> {
  const { instance } = (await WebAssembly.instantiate(readFileSync(wasmPath), {})) as unknown as { instance: WebAssembly.Instance }
  const x = instance.exports as unknown as GeomExports
  const read = (ptr: number, len: number) => new TextDecoder().decode(new Uint8Array(x.memory.buffer, ptr, len))
  return (op, text) => {
    const bytes = new TextEncoder().encode(`${op}\0${text}`)
    const at = x.geom_input(bytes.length)
    new Uint8Array(x.memory.buffer, at, bytes.length).set(bytes)
    if (x.geom_call() !== 0) throw new Error(`${op}: ${read(x.geom_error_ptr(), x.geom_error_len())}`)
    return read(x.geom_out_ptr(), x.geom_out_len())
  }
}

/** The 64-bit pattern of `x`, as hex. */
function bits(x: number): string {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

/**
 * FNV-1a over every number of a reply as little-endian f64 bits, in the reply's text order, as the native test takes
 * it. In two 32-bit halves: the prime is 2^40 + 0x1b3, so h * prime is h * 0x1b3 plus the low half moved up by 8 bits
 * into the high half.
 */
function digest(text: string): { numbers: number; digest: string } {
  let hi = 0xcbf29ce4
  let lo = 0x84222325
  let numbers = 0
  const bytes = new Uint8Array(8)
  const view = new DataView(bytes.buffer)
  const walk = (x: unknown): void => {
    if (typeof x === 'number') {
      view.setFloat64(0, x, true)
      for (const b of bytes) {
        lo = (lo ^ b) >>> 0
        const low = lo * 0x1b3
        const carry = Math.floor(low / 0x100000000)
        hi = (Math.imul(hi, 0x1b3) + carry + (lo << 8)) >>> 0
        lo = low >>> 0
      }
      numbers++
    } else if (Array.isArray(x)) x.forEach(walk)
    else if (x && typeof x === 'object') Object.values(x).forEach(walk)
  }
  walk(JSON.parse(text))
  return { numbers, digest: hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0') }
}

describe('the exact-parse record', () => {
  it('holds a reply for every recorded call, and the saved radius parses as recorded in JavaScript', () => {
    expect(requests.map((r) => r.case).sort()).toEqual(Object.keys(record.replies).sort())
    const saved = requests.find((r) => r.case === record.saved.case)!
    expect(saved.text).toContain(record.saved.text)
    expect(bits(JSON.parse(record.saved.text) as number)).toBe(record.saved.bits)
  })
})

describe.skipIf(!liveEngine)('long decimals in the wasm engine (a built engine)', () => {
  it('keeps the saved corner radius bit for bit', async () => {
    const geom = await rawGeom()
    const r = requests.find((x) => x.case === record.saved.case)!
    const reply = JSON.parse(geom(r.op, r.text)) as unknown
    const at = record.saved.reply.split('/').slice(1).reduce<unknown>((v, k) => (v as Record<string, unknown>)[k], reply)
    expect(bits(at as number)).toBe(record.saved.bits)
  })

  it('answers every recorded bracket call as the native engine does', async () => {
    const geom = await rawGeom()
    for (const r of requests) expect(digest(geom(r.op, r.text)), r.case).toEqual(record.replies[r.case])
  }, 120_000)
})
