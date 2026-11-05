// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//
// The address of a printer's own web page (Mainsail, Fluidd, OctoPrint, Duet Web Control, PrusaLink), built from
// the printer as it was saved, never from text a person or a client typed. Only hosts on the local network get a
// link, by the same rule the bridge applies before it connects a printer (`is_lan_host` in sx-link), so a saved
// host that points elsewhere cannot send anyone to an outside site.
import { connectionMethod } from './methods.ts'
import { ROOT_TLDS } from './root-tlds.ts'
import type { ConnectionId, ConnectionMethod, PrinterModel, WebUi } from './types.ts'

/** What the link is built from: the fields of a saved printer (`PrinterInfo` in @slicerx/contracts). */
export interface WebUiPrinter {
  plugin: string
  host?: string | undefined
  /** The port saved with the printer, for its connection. */
  port?: number | undefined
  /** The connection uses TLS: a page on the same server is https. */
  tls?: boolean | undefined
  /** Set for a printer reached through a remote tunnel: its page is not on this network, so it gets no link. */
  tunnel?: string | undefined
}

/**
 * The page a printer serves, or null when it serves none SlicerX knows of. The model's own page comes first when it
 * applies to the printer's connection, then the connection's default.
 */
export function webUiOf(plugin: string, model?: PrinterModel): WebUi | null {
  const own = model?.webUi
  if (own && (!own.via || own.via.includes(plugin as ConnectionId))) return own
  return methodOf(plugin)?.webUi ?? null
}

/** The address of the printer's web page, or null when it has none or its saved host is not on the local network. */
export function printerWebUiUrl(printer: WebUiPrinter, model?: PrinterModel): string | null {
  if (printer.tunnel || !printer.host) return null
  const ui = webUiOf(printer.plugin, model)
  if (!ui) return null
  const port = ui.sharesPort ? (printer.port ?? methodOf(printer.plugin)?.defaultPort ?? ui.port) : ui.port
  return webUiUrl(printer.host, port, ui.path, ui.sharesPort && printer.tls ? 'https' : 'http')
}

/**
 * `http://host:port/path` (or https) for a host on the local network that is not a root-zone TLD (a single label
 * such as `ai` can resolve on the internet), written as a browser writes it: names in lower
 * case without a trailing dot, IPv6 in its short form, no default port. Null for any other host, port or path.
 */
export function webUiUrl(host: string, port: number, path = '/', scheme: 'http' | 'https' = 'http'): string | null {
  const h = host
  if (!isLanHost(h) || isRootTld(h)) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (!/^\/[A-Za-z0-9\-._~/]*$/.test(path) || path.includes('//')) return null
  const v6 = h.includes(':') ? ipv6Segments(h) : null
  const name = v6 ? `[${shortIPv6(v6)}]` : h.replace(/\.$/, '').toLowerCase()
  const fallback = scheme === 'https' ? 443 : 80
  return `${scheme}://${name}${port === fallback ? '' : `:${port}`}${path}`
}

/**
 * True for a host meant for the local network: a private, loopback or link-local IP address, a `.local`, `.lan` or
 * `.home.arpa` name, or a single label (the web link also refuses a single label that is a root-zone TLD). A name a URL parser reads as an IPv4 number (its last label is
 * digits, or 0x and hex digits, as in `134744072` or `0x08080808`) is refused, and so is an address with a leading
 * zero, which a browser reads as octal: each would open a public address. The same rule as `is_lan_host` in sx-link;
 * both are tested against `packages/connect/fixtures/lan-hosts.json`.
 */
export function isLanHost(host: string): boolean {
  if (isIPv4(host)) return lanV4(host)
  if (host.includes(':')) return lanV6(host)
  // ASCII before lower case: the Kelvin sign lowercases to k.
  const raw = host.replace(/\.$/, '')
  if (!raw || raw.length > 253 || !/^[A-Za-z0-9.-]+$/.test(raw)) return false
  const h = raw.toLowerCase()
  if (endsInANumber(h)) return false
  return !h.includes('.') || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa')
}

/** The URL standard's "ends in a number": a last label of digits, or 0x and hex digits, makes the host an IPv4 address. */
function endsInANumber(h: string): boolean {
  const last = h.split('.').at(-1) ?? ''
  return /^\d+$/.test(last) || /^0x[0-9a-f]*$/.test(last)
}

/** A single label that is a top-level domain of the DNS root zone, such as `ai` or `com`. */
export function isRootTld(host: string): boolean {
  const h = host.replace(/\.$/, '').toLowerCase()
  return !h.includes('.') && ROOT_TLDS.has(h)
}

function methodOf(plugin: string): ConnectionMethod | undefined {
  try {
    return connectionMethod(plugin as ConnectionId)
  } catch {
    return undefined
  }
}

/** Four decimal octets without leading zeros, as Rust's parser takes them. */
function isIPv4(host: string): boolean {
  const parts = host.split('.')
  return parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)
}

function lanV4(host: string): boolean {
  const [a = 0, b = 0] = host.split('.').map(Number)
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

/** Loopback, unique local (fc00::/7) and link-local (fe80::/10). A zone (`%en0`) is refused: browsers drop it. */
function lanV6(host: string): boolean {
  const segs = ipv6Segments(host)
  if (!segs) return false
  const first = segs[0] ?? 0
  const loopback = segs.slice(0, 7).every((s) => s === 0) && segs[7] === 1
  return loopback || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
}

function ipv6Segments(host: string): number[] | null {
  if (!/^[0-9a-f:]+$/i.test(host) || host.split('::').length > 2) return null
  const [head = '', tail] = host.split('::')
  const part = (s: string) => (s ? s.split(':') : [])
  const a = part(head)
  const b = tail === undefined ? [] : part(tail)
  if (a.concat(b).some((x) => !/^[0-9a-f]{1,4}$/i.test(x))) return null
  const fill = 8 - a.length - b.length
  if (tail === undefined ? fill !== 0 : fill < 1) return null
  return [...a, ...Array<string>(tail === undefined ? 0 : fill).fill('0'), ...b].map((x) => parseInt(x, 16))
}

/** IPv6 as the URL standard writes it: lower-case hex without leading zeros, the first longest run of zeros as `::`. */
function shortIPv6(segs: number[]): string {
  let at = -1
  let len = 1
  for (let i = 0; i < segs.length; ) {
    if (segs[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < segs.length && segs[j] === 0) j++
    if (j - i > len) [at, len] = [i, j - i]
    i = j
  }
  const hex = segs.map((x) => x.toString(16))
  if (at < 0) return hex.join(':')
  return `${hex.slice(0, at).join(':')}::${hex.slice(at + len).join(':')}`
}
