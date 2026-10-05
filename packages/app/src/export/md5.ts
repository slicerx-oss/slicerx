// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// MD5 (RFC 1321), only for the plate_N.gcode.md5 file Bambu Lab printers check in a .gcode.3mf.
// Not for anything security related; the app's own file hashes are SHA-256.

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0)

export function md5Hex(data: Uint8Array): string {
  const len = data.length
  const padded = new Uint8Array(((len + 8) >>> 6) * 64 + 64)
  padded.set(data)
  padded[len] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, (len * 8) >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor((len * 8) / 2 ** 32), true)
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
  for (let off = 0; off < padded.length; off += 64) {
    let a = a0, b = b0, c = c0, d = d0
    for (let i = 0; i < 64; i++) {
      let fv: number
      let g: number
      if (i < 16) { fv = (b & c) | (~b & d); g = i }
      else if (i < 32) { fv = (d & b) | (~d & c); g = (5 * i + 1) % 16 }
      else if (i < 48) { fv = b ^ c ^ d; g = (3 * i + 5) % 16 }
      else { fv = c ^ (b | ~d); g = (7 * i) % 16 }
      const tmp = d
      d = c
      c = b
      const sum = (a + fv + K[i]! + view.getUint32(off + g * 4, true)) >>> 0
      b = (b + ((sum << S[i]!) | (sum >>> (32 - S[i]!)))) >>> 0
      a = tmp
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }
  const out = new DataView(new ArrayBuffer(16))
  out.setUint32(0, a0, true)
  out.setUint32(4, b0, true)
  out.setUint32(8, c0, true)
  out.setUint32(12, d0, true)
  return Array.from(new Uint8Array(out.buffer), (x) => x.toString(16).padStart(2, '0')).join('')
}
