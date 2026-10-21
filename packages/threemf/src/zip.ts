// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A small ZIP writer for 3MF files: entries are stored (no compression), which every 3MF reader
// accepts. Pure; returns the archive bytes.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** The CRC-32 of `data`; pass the CRC of the bytes before it as `prev` to run one over several pieces. */
export function crc32(data: Uint8Array, prev = 0): number {
  let c = (prev ^ 0xffffffff) >>> 0
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Text made piece by piece when it is written, for entries that run to hundreds of megabytes (a mesh's XML): the
 * compressed writer encodes and deflates one piece at a time, so the whole text never sits in memory as one string.
 * `String()` of it still gives the whole text.
 */
export class TextChunks {
  constructor(readonly chunks: () => Iterable<string>) {}
  toString(): string {
    return [...this.chunks()].join('')
  }
}

export interface ZipEntry {
  name: string
  data: Uint8Array | string
}

/** What the writers take: an entry, or one whose text is made as it is written. */
export type ZipInput = ZipEntry | { name: string; data: TextChunks }

/** DOS date and time for the entries: a fixed stamp, so the same project gives the same bytes. */
const DOS_TIME = 0
const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1

interface Packed {
  name: Uint8Array
  /** The bytes as stored in the archive. */
  data: Uint8Array
  crc: number
  /** Size before compression. */
  size: number
  method: 0 | 8
}

function assemble(files: readonly Packed[]): Uint8Array {
  const localSize = files.reduce((n, f) => n + 30 + f.name.length + f.data.length, 0)
  const centralSize = files.reduce((n, f) => n + 46 + f.name.length, 0)
  const out = new Uint8Array(localSize + centralSize + 22)
  const view = new DataView(out.buffer)
  let at = 0
  const offsets: number[] = []
  for (const f of files) {
    offsets.push(at)
    view.setUint32(at, 0x04034b50, true)
    view.setUint16(at + 4, 20, true)
    view.setUint16(at + 6, 0x0800, true) // UTF-8 names
    view.setUint16(at + 8, f.method, true)
    view.setUint16(at + 10, DOS_TIME, true)
    view.setUint16(at + 12, DOS_DATE, true)
    view.setUint32(at + 14, f.crc, true)
    view.setUint32(at + 18, f.data.length, true)
    view.setUint32(at + 22, f.size, true)
    view.setUint16(at + 26, f.name.length, true)
    view.setUint16(at + 28, 0, true)
    out.set(f.name, at + 30)
    out.set(f.data, at + 30 + f.name.length)
    at += 30 + f.name.length + f.data.length
  }
  const centralStart = at
  files.forEach((f, i) => {
    view.setUint32(at, 0x02014b50, true)
    view.setUint16(at + 4, 20, true)
    view.setUint16(at + 6, 20, true)
    view.setUint16(at + 8, 0x0800, true)
    view.setUint16(at + 10, f.method, true)
    view.setUint16(at + 12, DOS_TIME, true)
    view.setUint16(at + 14, DOS_DATE, true)
    view.setUint32(at + 16, f.crc, true)
    view.setUint32(at + 20, f.data.length, true)
    view.setUint32(at + 24, f.size, true)
    view.setUint16(at + 28, f.name.length, true)
    view.setUint32(at + 42, offsets[i]!, true)
    out.set(f.name, at + 46)
    at += 46 + f.name.length
  })
  view.setUint32(at, 0x06054b50, true)
  view.setUint16(at + 8, files.length, true)
  view.setUint16(at + 10, files.length, true)
  view.setUint32(at + 12, at - centralStart, true)
  view.setUint32(at + 16, centralStart, true)
  return out
}

function concat(parts: readonly Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1 && parts[0]!.length === size) return parts[0]!
  const out = new Uint8Array(size)
  let at = 0
  for (const c of parts) {
    out.set(c, at)
    at += c.length
  }
  return out
}

function bytesOf(e: ZipInput): Uint8Array {
  if (typeof e.data === 'string') return new TextEncoder().encode(e.data)
  if (e.data instanceof Uint8Array) return e.data
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  let size = 0
  for (const c of e.data.chunks()) {
    const b = enc.encode(c)
    parts.push(b)
    size += b.length
  }
  return concat(parts, size)
}

/** A stored (uncompressed) archive, built at once. For small files and tests. */
export function zip(entries: readonly ZipInput[]): Uint8Array {
  const enc = new TextEncoder()
  return assemble(entries.map((e) => {
    const data = bytesOf(e)
    return { name: enc.encode(e.name), data, crc: crc32(data), size: data.length, method: 0 as const }
  }))
}

async function deflateRaw(source: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = source.pipeThrough(new CompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  return concat(chunks, size)
}

/** Deflates text pieces as they are made, keeping only the compressed bytes; returns them with the raw size and CRC. */
async function deflateChunks(text: TextChunks): Promise<{ packed: Uint8Array; crc: number; size: number }> {
  const enc = new TextEncoder()
  const it = text.chunks()[Symbol.iterator]()
  let crc = 0
  let size = 0
  const source = new ReadableStream<Uint8Array>({
    pull: (c) => {
      const r = it.next()
      if (r.done) return c.close()
      const b = enc.encode(r.value)
      crc = crc32(b, crc)
      size += b.length
      c.enqueue(b)
    },
  }, { highWaterMark: 1 })
  const packed = await deflateRaw(source)
  return { packed, crc, size }
}

/** A deflated archive, as 3MF tools write them. Projects with real meshes run to hundreds of megabytes stored. */
export async function zipCompressed(entries: readonly ZipInput[]): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const files: Packed[] = []
  for (const e of entries) {
    if (e.data instanceof TextChunks) {
      // Model text: deflated piece by piece, always (XML shrinks; a tiny entry a few bytes over is still valid).
      const { packed, crc, size } = await deflateChunks(e.data)
      files.push({ name: enc.encode(e.name), data: packed, crc, size, method: 8 })
      continue
    }
    const raw = bytesOf(e)
    const packed = raw.length < 64 ? null : await deflateRaw(new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(raw), c.close()) }))
    const useful = packed !== null && packed.length < raw.length
    files.push({ name: enc.encode(e.name), data: useful ? packed : raw, crc: crc32(raw), size: raw.length, method: useful ? 8 : 0 })
  }
  return assemble(files)
}

/** Reads a stored ZIP back into entries (for tests and for checking what we wrote). */
export function unzipStored(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Map<string, Uint8Array>()
  let at = 0
  const dec = new TextDecoder()
  while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true)
    const nameLen = view.getUint16(at + 26, true)
    const extra = view.getUint16(at + 28, true)
    const name = dec.decode(bytes.subarray(at + 30, at + 30 + nameLen))
    const start = at + 30 + nameLen + extra
    out.set(name, bytes.subarray(start, start + size))
    at = start + size
  }
  return out
}
