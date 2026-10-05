// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Byte helpers shared by the pairing and session code. Base64url without padding is the one
// binary encoding on the wire.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]))

export function toB64url(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64.charAt(n >> 18) + B64.charAt((n >> 12) & 63) + B64.charAt((n >> 6) & 63) + B64.charAt(n & 63)
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16
    out += B64.charAt(n >> 18) + B64.charAt((n >> 12) & 63)
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8)
    out += B64.charAt(n >> 18) + B64.charAt((n >> 12) & 63) + B64.charAt((n >> 6) & 63)
  }
  return out
}

/** Standard padded base64, for pictures the phone puts into a `data:` URI. */
export function toB64(bytes: Uint8Array): string {
  const url = toB64url(bytes).replaceAll('-', '+').replaceAll('_', '/')
  return url + '='.repeat((4 - (url.length % 4)) % 4)
}

/** Returns null for anything that is not canonical unpadded base64url. */
export function fromB64url(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let acc = 0
  let bits = 0
  let o = 0
  for (const c of text) {
    const v = B64_INDEX.get(c)
    if (v === undefined) return null
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  // Leftover bits must be zero, so every byte string has exactly one encoding.
  if ((acc & ((1 << bits) - 1)) !== 0) return null
  return out
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
export const fromUtf8 = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes)

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Length-prefixed concatenation, so field boundaries in a transcript cannot shift. */
export function frame(...parts: (Uint8Array | string)[]): Uint8Array {
  return concat(
    ...parts.flatMap((p) => {
      const b = typeof p === 'string' ? utf8(p) : p
      return [u32be(b.length), b]
    }),
  )
}

export function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n >>> 0)
  return out
}

export function u64be(n: number): Uint8Array {
  const out = new Uint8Array(8)
  const view = new DataView(out.buffer)
  view.setUint32(0, Math.floor(n / 2 ** 32))
  view.setUint32(4, n >>> 0)
  return out
}

/** Constant time for equal lengths; lengths are public in every use here. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Copies into a fresh ArrayBuffer, since a Uint8Array view may sit inside a larger one. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(out).set(bytes)
  return out
}
