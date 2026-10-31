// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Just enough ZIP for 3MF packages: read entries (stored or deflated) and write a deflated archive.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { constants, crc32, deflateRawSync, inflateRawSync } from 'node:zlib'
import { ToolInputError } from './models'

/** Largest entry this reader inflates, in bytes; a project's settings are kilobytes, a plate's G-code tens of megabytes. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024

/** Largest entry `text` and `head` read, in bytes. */
export const MAX_TEXT_BYTES = 64 * 1024 * 1024

export interface ZipReader {
  names(): string[]
  /** The entry's bytes, or undefined when the archive has no such entry. Larger than `max` bytes throws. */
  read(name: string, max?: number): Buffer | undefined
  text(name: string): string | undefined
  /**
   * The entry's first `bytes` bytes (all of them when it is shorter), inflating no more of it than that takes; undefined
   * when the archive has no such entry. An entry larger than `text` reads throws, as `text` does.
   */
  head(name: string, bytes: number): Buffer | undefined
}

/** A ZIP read from a file: only its directory and the entries asked for. `close` it when done. */
export interface ZipFile extends ZipReader {
  close(): void
}

export function readZip(buf: Buffer, label = 'file'): ZipReader {
  return zipOf(buf.length, (at, len) => buf.subarray(at, at + len), label)
}

/**
 * The ZIP at `path`, read in place: its end record and directory now, each entry when asked for, so a project's
 * settings come out without the whole file in memory. The file stays open until `close`.
 */
export function openZip(path: string, label = 'file'): ZipFile {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const pread = (at: number, len: number): Buffer => {
      const b = Buffer.allocUnsafe(Math.max(0, Math.min(len, size - at)))
      let got = 0
      while (got < b.length) {
        const n = readSync(fd, b, got, b.length - got, at + got)
        if (n <= 0) break
        got += n
      }
      return got === b.length ? b : b.subarray(0, got)
    }
    return { ...zipOf(size, pread, label), close: () => closeSync(fd) }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

/** The ZIP of `total` bytes that `pread` reads from (`len` bytes at `at`, fewer past the end). */
function zipOf(total: number, pread: (at: number, len: number) => Buffer, label: string): ZipReader {
  // The end of central directory record sits in the last 64 KiB + 22 bytes.
  const tailAt = Math.max(0, total - 65_557)
  const tail = pread(tailAt, total - tailAt)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ToolInputError(`${label} is not a ZIP archive (3MF files are ZIP packages)`, 'invalid_model')
  const count = tail.readUInt16LE(eocd + 10)
  // From the directory to the end of the file, so a directory is checked against the file as a whole.
  const at = tail.readUInt32LE(eocd + 16)
  const dir = pread(at, total - at)
  let p = 0
  const entries = new Map<string, { method: number; size: number; usize: number; offset: number }>()
  for (let n = 0; n < count; n++) {
    if (p + 46 > dir.length || dir.readUInt32LE(p) !== 0x02014b50) throw new ToolInputError(`${label} has a damaged ZIP directory`, 'invalid_model')
    const nameLen = dir.readUInt16LE(p + 28)
    const name = dir.toString('utf8', p + 46, p + 46 + nameLen)
    entries.set(name, { method: dir.readUInt16LE(p + 10), size: dir.readUInt32LE(p + 20), usize: dir.readUInt32LE(p + 24), offset: dir.readUInt32LE(p + 42) })
    p += 46 + nameLen + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32)
  }
  /** Where an entry's data starts, past its local header. */
  const dataAt = (e: { offset: number }): number => {
    const head = pread(e.offset, 30)
    return e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
  }
  const inflate = (name: string, raw: Buffer, max: number, partial = false): Buffer => {
    try {
      return inflateRawSync(raw, { maxOutputLength: max, ...(partial ? { finishFlush: constants.Z_SYNC_FLUSH } : {}) })
    } catch {
      throw new ToolInputError(`${label}: ${name} is damaged or larger than it says`, 'invalid_model')
    }
  }
  const read = (name: string, max = MAX_ENTRY_BYTES): Buffer | undefined => {
    const e = entries.get(name)
    if (!e) return undefined
    if (e.usize > max) throw new ToolInputError(`${label}: ${name} is over the ${max} byte limit`, 'invalid_model')
    const raw = pread(dataAt(e), e.size)
    if (e.method === 0) return Buffer.from(raw)
    if (e.method === 8) return inflate(name, raw, max)
    throw new ToolInputError(`${label}: ${name} uses ZIP method ${e.method}, which is not supported`, 'invalid_model')
  }
  const head = (name: string, bytes: number): Buffer | undefined => {
    const e = entries.get(name)
    if (!e || e.usize > MAX_TEXT_BYTES || (e.method !== 0 && e.method !== 8)) return read(name, MAX_TEXT_BYTES)?.subarray(0, bytes)
    const start = dataAt(e)
    if (e.method === 0) return Buffer.from(pread(start, Math.min(e.size, bytes)))
    // Inflate a growing start of the stream until it gives `bytes`; all of it is inflated as `read` does.
    for (let take = Math.min(e.size, 16 * 1024); ; take = Math.min(e.size, take * 4)) {
      const out = inflate(name, pread(start, take), MAX_TEXT_BYTES, take < e.size)
      if (out.length >= bytes || take >= e.size) return out.subarray(0, bytes)
    }
  }
  return { names: () => [...entries.keys()], read, text: (name) => read(name, MAX_TEXT_BYTES)?.toString('utf8'), head }
}

/** A deflated ZIP of the entries, in order. No ZIP64, so the archive stays under 4 GiB. */
export function writeZip(entries: { name: string; data: string | Uint8Array }[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const data = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : Buffer.from(e.data)
    const packed = deflateRawSync(data)
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6) // UTF-8 names
    head.writeUInt16LE(8, 8)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(packed.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(name.length, 26)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0x0800, 8)
    dir.writeUInt16LE(8, 10)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(packed.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(name.length, 28)
    dir.writeUInt32LE(offset, 42)
    local.push(head, name, packed)
    central.push(dir, name)
    offset += head.length + name.length + packed.length
  }
  const size = central.reduce((a, b) => a + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(size, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, ...central, end])
}
