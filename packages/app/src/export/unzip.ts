// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Reads the entries of a zip archive (a 3MF project, a preset bundle). The archive is untrusted: entry count, sizes
// and names are capped before anything is inflated. No imports, so the project worker loads it on its own.

const MAX_ENTRIES = 4000
const MAX_ENTRY = 256 * 1024 * 1024
const MAX_TOTAL = 768 * 1024 * 1024

export class ProjectReadError extends Error {}

/** Caps for an untrusted archive: how many entries, how large one entry and all of them may be once inflated. */
export interface ZipLimits {
  entries: number
  entry: number
  total: number
  /** What the archive should be, for the message when it is not a zip at all. */
  what?: string
}

const PROJECT_LIMITS: ZipLimits = { entries: MAX_ENTRIES, entry: MAX_ENTRY, total: MAX_TOTAL, what: 'a 3MF archive' }

/**
 * Reads the archive's entries. Stored and deflated entries only; anything else is refused. With `keep`, only the entries
 * it accepts are inflated and returned (every name and size is still checked).
 */
export async function unzipEntries(bytes: Uint8Array, limits: ZipLimits = PROJECT_LIMITS, keep?: (name: string) => boolean): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ProjectReadError(`This is not ${limits.what ?? 'a zip archive'}.`)
  let count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  // ZIP64: the real count and directory offset sit in a record the locator before the end record points to.
  if ((count === 0xffff || at === 0xffffffff) && eocd >= 20 && view.getUint32(eocd - 20, true) === 0x07064b50) {
    const rec = Number(view.getBigUint64(eocd - 20 + 8, true))
    if (rec + 56 > bytes.length || view.getUint32(rec, true) !== 0x06064b50) throw new ProjectReadError('The archive is damaged.')
    count = Number(view.getBigUint64(rec + 32, true))
    at = Number(view.getBigUint64(rec + 48, true))
  }
  if (count > limits.entries) throw new ProjectReadError('The archive has too many files.')
  const dec = new TextDecoder()
  const out = new Map<string, Uint8Array>()
  let total = 0
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new ProjectReadError('The archive is damaged.')
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    let csize = view.getUint32(at + 20, true)
    let usize = view.getUint32(at + 24, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    let local = view.getUint32(at + 42, true)
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen))
    // ZIP64 extra field: the values that did not fit in 32 bits, in this order.
    if (usize === 0xffffffff || csize === 0xffffffff || local === 0xffffffff) {
      let e = at + 46 + nameLen
      const end = e + extraLen
      while (e + 4 <= end) {
        const tag = view.getUint16(e, true)
        const size = view.getUint16(e + 2, true)
        if (tag === 1) {
          let p = e + 4
          if (usize === 0xffffffff) (usize = Number(view.getBigUint64(p, true))), (p += 8)
          if (csize === 0xffffffff) (csize = Number(view.getBigUint64(p, true))), (p += 8)
          if (local === 0xffffffff) local = Number(view.getBigUint64(p, true))
        }
        e += 4 + size
      }
    }
    at += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    if (flags & 1) throw new ProjectReadError('The archive is encrypted.')
    if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name) || name.includes('\0') || name.split(/[\\/]/).includes('..')) throw new ProjectReadError('The archive has a file with an unsafe path.')
    if (usize > limits.entry || (total += usize) > limits.total) throw new ProjectReadError('The archive is too large to open.')
    if (local + 30 > bytes.length) throw new ProjectReadError('The archive is damaged.')
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    if (keep && !keep(name)) continue
    const raw = bytes.subarray(start, start + csize)
    if (raw.length !== csize) throw new ProjectReadError('The archive is damaged.')
    if (method === 0) out.set(name, raw.length === usize ? raw : raw.subarray(0, Math.min(raw.length, usize)))
    else if (method === 8) out.set(name, await inflate(raw, usize, limits.entry))
    else throw new ProjectReadError('The archive uses a compression this app cannot read.')
  }
  return out
}

async function inflate(raw: Uint8Array, expected: number, cap: number): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(raw), c.close()) })
  const stream = source.pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    // A lying header cannot make the output bigger than it declared.
    if (size > expected || size > cap) {
      await reader.cancel()
      throw new ProjectReadError('A file in the archive inflates to more than it declares.')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}
