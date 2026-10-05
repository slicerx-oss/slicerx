// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What leaves this computer in a bug report has these removed first (docs/bug-intake.md, Scrubbing):
// tokens and keys, printer access codes and serials, IP addresses, emails and home folder names. The
// rules match the Discord poller's (kept outside this repository), which scrubs everything again.
// Also the fingerprint that groups repeats of one crash: a hash of the normalized top stack frames.

const R = '[redacted]'

const NAMED = String.raw`api[_-]?key|apikey|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|password|passwd|pwd|(?:dev[_-]?)?access[_ -]?code|accesscode|lan[_-]?code|serial(?:[_ -]?(?:number|no))?|dev[_-]?id|device[_-]?id|sn`

const RULES: [RegExp, string][] = [
  // user:password@ in a URL, such as mqtts://bblp:12345678@printer
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${R}@`],
  // name = value secrets, printer access codes and serials
  [new RegExp(String.raw`(["']?\b(?:${NAMED})\b["']?\s*[:=]\s*)["']?[^\s"',;}&]+["']?`, 'gi'), `$1${R}`],
  [/\b(access code|serial number|serial)\s+(?:is\s+)?([A-Za-z0-9]{6,})\b/gi, `$1 ${R}`],
  // Bambu Lab serials, 15 characters
  [/\b0[0-9A-Z]{2}[0-9A-Z]{2}[A-Z][0-9A-Z]{9}\b/g, `<serial ${R}>`],
  // tokens and keys, after name = value so a named key goes whole
  [/\bsxk_[A-Za-z0-9_-]+/g, `sxk_${R}`],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, `<jwt ${R}>`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${R}`],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g, `<key ${R}>`],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}/g, `<key ${R}>`],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, `<key ${R}>`],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, `<key ${R}>`],
  [/\bAKIA[0-9A-Z]{16}\b/g, `<key ${R}>`],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, `<key ${R}>`],
  // contact
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, `<email ${R}>`],
  // home folders become ~
  [/(?:file:\/\/)?\/Users\/[^/\s"'<>]+/g, '~'],
  [/(?:file:\/\/)?\/home\/[^/\s"'<>]+/g, '~'],
  [/[A-Z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+/gi, '~'],
]

const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g
const IPV6 = /(?<![0-9A-Za-z:])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?:%[0-9A-Za-z]+)?(?![0-9A-Za-z:])/g

export function isIPv4(s: string): boolean {
  const parts = s.split('.')
  return parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)
}

/** Text forms Python's ipaddress accepts, without an embedded IPv4 tail (the candidates have no dots). */
export function isIPv6(s: string): boolean {
  const halves = s.split('::')
  if (halves.length > 2) return false
  const groups = (x: string) => (x === '' ? [] : x.split(':'))
  const all = [...groups(halves[0]!), ...(halves.length === 2 ? groups(halves[1]!) : [])]
  if (!all.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false
  return halves.length === 2 ? all.length <= 7 : all.length === 8
}

export function scrub(text: string): string {
  let s = text
  for (const [re, rep] of RULES) s = s.replace(re, rep)
  s = s.replace(IPV4, (m) => (isIPv4(m) ? `<ip ${R}>` : m))
  s = s.replace(IPV6, (m) => (isIPv6(m.split('%')[0]!) ? `<ip ${R}>` : m))
  return s
}

// Fingerprint ------------------------------------------------------------------------------------

/** Runtime frames that say nothing about where a Rust panic came from. */
const RUST_NOISE = /^(?:<?(?:std|core|alloc|backtrace|panic_unwind|tauri_runtime_wry|tao|objc2?)::|rust_begin_unwind|__rust|_?start|main$|__libc|slicerx::crash::|BaseThreadInitThunk|RtlUserThreadStart)/

/** One stack line as `function (file)`, without line numbers, origins, query strings or build hashes; null when it is not a frame. */
export function normalizeFrame(line: string): string | null {
  const t = line.trim()
  if (!t) return null
  let fn = ''
  let loc = ''
  let m: RegExpExecArray | null
  if ((m = /^at\s+(?:async\s+)?(.*?)\s+\((.*)\)$/.exec(t))) [fn, loc] = [m[1]!, m[2]!]
  else if ((m = /^at\s+(?:async\s+)?(.*)$/.exec(t))) loc = m[1]!
  else if ((m = /^\d+:\s+(?:0x[0-9a-f]+ - )?(.+)$/i.exec(t))) {
    // Rust: "  12: sx_core::slice::run::h0123456789abcdef"
    fn = m[1]!.replace(/::h[0-9a-f]{16}$/, '')
    if (RUST_NOISE.test(fn)) return null
    return fn
  } else if ((m = /^(.*?)@(.*)$/.exec(t))) [fn, loc] = [m[1]!, m[2]!]
  else return null
  const file = loc
    .replace(/[?#].*?(?=:\d+(?::\d+)?$|$)/, '')
    .replace(/:\d+(?::\d+)?$/, '')
    .split(/[\\/]/)
    .pop()!
    .replace(/-[A-Za-z0-9_-]{8}(?=\.m?js$)/, '')
  if (!fn && !file) return null
  return file ? `${fn || '<anonymous>'} (${file})` : fn
}

/** The first `n` frames of a stack that carry information, normalized. */
export function topFrames(stack: string, n = 5): string[] {
  const out: string[] = []
  for (const line of stack.split('\n')) {
    if (/^\s+at \S+\.rs:\d+/.test(line)) continue // the source line under a Rust frame
    const f = normalizeFrame(line)
    if (f) out.push(f)
    if (out.length >= n) break
  }
  return out
}

/** A message without the parts that change between runs: numbers, addresses, quoted values. */
export function normalizeMessage(message: string): string {
  return (message.split('\n')[0] ?? '')
    .replace(/0x[0-9a-f]+/gi, '0x')
    .replace(/\b[0-9a-f]{8,}\b/gi, 'x')
    .replace(/\d+/g, '0')
    .replace(/(["'`]).*?\1/g, '$1$1')
    .trim()
}

/**
 * Groups repeats of one crash: SHA-256 (hex) of the error type and the top five normalized frames, or of the
 * normalized message when the stack has no frames.
 */
export function fingerprint(message: string, stack: string | null): string {
  const frames = stack ? topFrames(stack) : []
  const kind = /^([A-Za-z_$][\w$.]*?(?:Error|Exception|panic)?)(?::|$)/.exec(message.trim())?.[1] ?? ''
  const basis = frames.length ? [kind, ...frames].join('\n') : normalizeMessage(message)
  return sha256Hex(basis)
}

// SHA-256, small and synchronous, so a crash is fingerprinted where it is caught.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text)
  const bits = data.length * 8
  const len = ((data.length + 9 + 63) >> 6) << 6
  const buf = new Uint8Array(len)
  buf.set(data)
  buf[data.length] = 0x80
  const view = new DataView(buf.buffer)
  view.setUint32(len - 8, Math.floor(bits / 2 ** 32))
  view.setUint32(len - 4, bits >>> 0)
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < len; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!
      w[i] = (w[i - 16]! + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!]
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      ;[hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0]
    }
    h[0] = (h[0]! + a) >>> 0
    h[1] = (h[1]! + b) >>> 0
    h[2] = (h[2]! + c) >>> 0
    h[3] = (h[3]! + d) >>> 0
    h[4] = (h[4]! + e) >>> 0
    h[5] = (h[5]! + f) >>> 0
    h[6] = (h[6]! + g) >>> 0
    h[7] = (h[7]! + hh) >>> 0
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('')
}
