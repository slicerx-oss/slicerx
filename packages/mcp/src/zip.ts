// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Just enough ZIP for 3MF packages: read entries (stored or deflated) and write a deflated archive.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'
import { ToolInputError } from './models'

/** Largest entry this reader inflates, in bytes; a project's settings are kilobytes, a plate's G-code tens of megabytes. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024

export interface ZipReader {
  names(): string[]
  /** The entry's bytes, or undefined when the archive has no such entry. Larger than `max` bytes throws. */
  read(name: string, max?: number): Buffer | undefined
  text(name: string): string | undefined
}

export function readZip(buf: Buffer, label = 'file'): ZipReader {
  // The end of central directory record sits in the last 64 KiB + 22 bytes.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ToolInputError(`${label} is not a ZIP archive (3MF files are ZIP packages)`, 'invalid_model')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const entries = new Map<string, { method: number; size: number; usize: number; offset: number }>()
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ToolInputError(`${label} has a damaged ZIP directory`, 'invalid_model')
    const nameLen = buf.readUInt16LE(p + 28)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    entries.set(name, { method: buf.readUInt16LE(p + 10), size: buf.readUInt32LE(p + 20), usize: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42) })
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  const read = (name: string, max = MAX_ENTRY_BYTES): Buffer | undefined => {
    const e = entries.get(name)
    if (!e) return undefined
    if (e.usize > max) throw new ToolInputError(`${label}: ${name} is over the ${max} byte limit`, 'invalid_model')
    const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28)
    const raw = buf.subarray(start, start + e.size)
    if (e.method === 0) return Buffer.from(raw)
    if (e.method === 8) {
      try {
        return inflateRawSync(raw, { maxOutputLength: max })
      } catch {
        throw new ToolInputError(`${label}: ${name} is damaged or larger than it says`, 'invalid_model')
      }
    }
    throw new ToolInputError(`${label}: ${name} uses ZIP method ${e.method}, which is not supported`, 'invalid_model')
  }
  return { names: () => [...entries.keys()], read, text: (name) => read(name, 64 * 1024 * 1024)?.toString('utf8') }
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
