// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plates of a 3MF project, read on the phone from the file itself, so the person can pick one before anything is
// uploaded. A project lists its plates in Metadata/model_settings.config (`<plate>` with `plater_id`, `plater_name`
// and one `model_instance` per object on it), the same numbers the cloud slicer takes in `options.plates`. The phone's
// runtime has no inflate, so the one entry is read with the small raw DEFLATE reader below, capped in size.

export interface ProjectPlate {
  /** The plate's number in the project (`plater_id`), as `options.plates` names it. */
  plate: number
  /** The plate's name in the project, or empty when it has none. */
  name: string
  /** Objects on the plate. */
  objects: number
}

const SETTINGS = 'metadata/model_settings.config'
/** model_settings.config is a few KB; anything far past this is not a plate list worth reading on a phone. */
const MAX_SETTINGS_BYTES = 8 * 1024 * 1024

/**
 * The plates of a 3MF project that have objects on them, in the file's order. An empty list for a 3MF with no plate
 * list (one plate, as the cloud slicer reads it) and for anything that is not a readable zip.
 */
export function readPlates(data: ArrayBuffer | Uint8Array): ProjectPlate[] {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  try {
    const xml = zipEntry(bytes, SETTINGS)
    return xml ? platesOf(utf8(xml)) : []
  } catch {
    return []
  }
}

/** The plates in a model_settings.config, with objects on them, each plate number once. */
export function platesOf(xml: string): ProjectPlate[] {
  const out: ProjectPlate[] = []
  let cur: { plate: number | null; name: string; objects: number } | null = null
  let inInstance = false
  let instanceHasObject = false
  for (const m of xml.matchAll(/<(\/?)([A-Za-z_][\w.-]*)([^>]*?)(\/?)>/g)) {
    const closing = m[1] === '/'
    const name = m[2]
    const selfClosing = m[4] === '/'
    if (name === 'plate') {
      if (!closing) cur = { plate: null, name: '', objects: 0 }
      if (closing || selfClosing) {
        if (cur && cur.plate !== null && cur.objects > 0 && !out.some((p) => p.plate === cur!.plate)) out.push({ plate: cur.plate, name: cur.name, objects: cur.objects })
        cur = null
      }
    } else if (name === 'model_instance') {
      if (closing) {
        if (cur && instanceHasObject) cur.objects++
        inInstance = false
      } else if (!selfClosing) {
        inInstance = true
        instanceHasObject = false
      }
    } else if (name === 'metadata' && !closing && cur) {
      const attrs = attrsOf(m[3] ?? '')
      const key = attrs.get('key')
      const value = attrs.get('value') ?? ''
      if (inInstance) {
        if (key === 'object_id' && /^\d+$/.test(value)) instanceHasObject = true
      } else if (key === 'plater_id' && /^\d+$/.test(value)) {
        const n = Number(value)
        if (n >= 1) cur.plate = n
      } else if (key === 'plater_name') {
        cur.name = value.trim()
      }
    }
  }
  return out
}

function attrsOf(s: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of s.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out.set(m[1]!, entities(m[2] ?? m[3] ?? ''))
  return out
}

function entities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e as 'amp']
  })
}

/** UTF-8 text, through TextDecoder where the runtime has one. */
function utf8(b: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(b)
  let s = ''
  for (let i = 0; i < b.length; ) {
    const c = b[i++]!
    let cp = c
    if (c >= 0xf0) cp = ((c & 7) << 18) | ((b[i++]! & 63) << 12) | ((b[i++]! & 63) << 6) | (b[i++]! & 63)
    else if (c >= 0xe0) cp = ((c & 15) << 12) | ((b[i++]! & 63) << 6) | (b[i++]! & 63)
    else if (c >= 0xc0) cp = ((c & 31) << 6) | (b[i++]! & 63)
    s += String.fromCodePoint(cp)
  }
  return s
}

/** The bytes of the zip entry named `want` (compared without case), or null when the archive has none. */
export function zipEntry(b: Uint8Array, want: string): Uint8Array | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let end = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('not a zip')
  const count = v.getUint16(end + 10, true)
  let at = v.getUint32(end + 16, true)
  for (let n = 0; n < count; n++) {
    if (at + 46 > b.length || v.getUint32(at, true) !== 0x02014b50) throw new Error('bad zip directory')
    const method = v.getUint16(at + 10, true)
    const size = v.getUint32(at + 20, true)
    const full = v.getUint32(at + 24, true)
    const nameLen = v.getUint16(at + 28, true)
    const skip = nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true)
    const local = v.getUint32(at + 42, true)
    let name = ''
    for (let i = 0; i < nameLen; i++) name += String.fromCharCode(b[at + 46 + i]!)
    at += 46 + skip
    if (name.replace(/^\/+/, '').toLowerCase() !== want) continue
    if (full > MAX_SETTINGS_BYTES || local + 30 > b.length || v.getUint32(local, true) !== 0x04034b50) throw new Error('unreadable entry')
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)
    if (start + size > b.length) throw new Error('entry past the end of the file')
    const raw = b.subarray(start, start + size)
    if (method === 0) return raw
    if (method === 8) return inflateRaw(raw, MAX_SETTINGS_BYTES)
    throw new Error('unsupported compression')
  }
  return null
}

// Raw DEFLATE (RFC 1951): stored, fixed and dynamic Huffman blocks.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

interface Huffman {
  counts: Uint16Array
  symbols: Uint16Array
}

function huffman(lengths: ArrayLike<number>): Huffman {
  const counts = new Uint16Array(16)
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]!]!++
  counts[0] = 0
  const offs = new Uint16Array(16)
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1]! + counts[i - 1]!
  const symbols = new Uint16Array(lengths.length)
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbols[offs[lengths[i]!]!++] = i
  return { counts, symbols }
}

const FIXED = (() => {
  const lit = new Uint8Array(288)
  lit.fill(8, 0, 144)
  lit.fill(9, 144, 256)
  lit.fill(7, 256, 280)
  lit.fill(8, 280, 288)
  return { lit: huffman(lit), dist: huffman(new Uint8Array(30).fill(5)) }
})()

/** Inflates raw DEFLATE data; throws on bad data or when the output would pass `cap` bytes. */
export function inflateRaw(src: Uint8Array, cap: number): Uint8Array {
  let pos = 0
  let tag = 0
  let have = 0
  let out = new Uint8Array(Math.min(cap, Math.max(1024, src.length * 4)))
  let len = 0
  const bit = (): number => {
    if (have === 0) {
      if (pos >= src.length) throw new Error('deflate data ends early')
      tag = src[pos++]!
      have = 8
    }
    const b = tag & 1
    tag >>= 1
    have--
    return b
  }
  const bits = (n: number): number => {
    let v = 0
    for (let i = 0; i < n; i++) v |= bit() << i
    return v
  }
  const decode = (h: Huffman): number => {
    let cur = 0
    let sum = 0
    for (let l = 1; l < 16; l++) {
      cur = 2 * cur + bit()
      sum += h.counts[l]!
      cur -= h.counts[l]!
      if (cur < 0) return h.symbols[sum + cur]!
    }
    throw new Error('bad deflate code')
  }
  const room = (n: number) => {
    if (len + n > cap) throw new Error('inflated data is too large')
    if (len + n <= out.length) return
    const next = new Uint8Array(Math.min(cap, Math.max(out.length * 2, len + n)))
    next.set(out.subarray(0, len))
    out = next
  }
  let last = 0
  do {
    last = bit()
    const type = bits(2)
    if (type === 0) {
      have = 0
      if (pos + 4 > src.length) throw new Error('deflate data ends early')
      const n = src[pos]! | (src[pos + 1]! << 8)
      if ((n ^ (src[pos + 2]! | (src[pos + 3]! << 8))) !== 0xffff) throw new Error('bad stored block')
      pos += 4
      if (pos + n > src.length) throw new Error('deflate data ends early')
      room(n)
      out.set(src.subarray(pos, pos + n), len)
      len += n
      pos += n
      continue
    }
    if (type === 3) throw new Error('bad deflate block')
    let lit = FIXED.lit
    let dist = FIXED.dist
    if (type === 2) {
      const hlit = bits(5) + 257
      const hdist = bits(5) + 1
      const hclen = bits(4) + 4
      const code = new Uint8Array(19)
      for (let i = 0; i < hclen; i++) code[CODE_ORDER[i]!] = bits(3)
      const codes = huffman(code)
      const lengths = new Uint8Array(hlit + hdist)
      for (let i = 0; i < hlit + hdist; ) {
        const sym = decode(codes)
        if (sym < 16) {
          lengths[i++] = sym
          continue
        }
        const [value, n] = sym === 16 ? [i > 0 ? lengths[i - 1]! : -1, 3 + bits(2)] : sym === 17 ? [0, 3 + bits(3)] : [0, 11 + bits(7)]
        if (value < 0 || i + n > hlit + hdist) throw new Error('bad deflate lengths')
        lengths.fill(value, i, i + n)
        i += n
      }
      lit = huffman(lengths.subarray(0, hlit))
      dist = huffman(lengths.subarray(hlit))
    }
    for (;;) {
      const sym = decode(lit)
      if (sym < 256) {
        room(1)
        out[len++] = sym
        continue
      }
      if (sym === 256) break
      const l = sym - 257
      if (l >= LEN_BASE.length) throw new Error('bad deflate length')
      const n = LEN_BASE[l]! + bits(LEN_EXTRA[l]!)
      const d = decode(dist)
      if (d >= DIST_BASE.length) throw new Error('bad deflate distance')
      const back = DIST_BASE[d]! + bits(DIST_EXTRA[d]!)
      if (back > len) throw new Error('bad deflate distance')
      room(n)
      for (let i = 0; i < n; i++, len++) out[len] = out[len - back]!
    }
  } while (!last)
  return out.slice(0, len)
}
