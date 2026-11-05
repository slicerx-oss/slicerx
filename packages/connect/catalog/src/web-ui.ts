// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//
// The address of a printer's own web page (Mainsail, Fluidd, OctoPrint, Duet Web Control, PrusaLink), built from
// the printer as it was saved, never from text a person or a client typed. Only hosts on the local network get a
// link, by the same rule the bridge applies before it connects a printer (`is_lan_host` in sx-link), so a saved
// host that points elsewhere cannot send anyone to an outside site.
import { connectionMethod } from './methods.ts'
import type { ConnectionId, ConnectionMethod, PrinterModel, WebUi } from './types.ts'

/** What the link is built from: the fields of a saved printer (`PrinterInfo` in @slicerx/contracts). */
export interface WebUiPrinter {
  plugin: string
  host?: string | undefined
  /** The port saved with the printer, for its connection. */
  port?: number | undefined
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
  return webUiUrl(printer.host, port, ui.path)
}

/** `http://host:port/path` for a host on the local network; null for any other host, a bad port or a bad path. */
export function webUiUrl(host: string, port: number, path = '/'): string | null {
  const h = host.trim()
  if (!isLanHost(h)) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (!/^\/[A-Za-z0-9\-._~/]*$/.test(path) || path.includes('//')) return null
  const name = h.includes(':') ? `[${h}]` : h.replace(/\.$/, '')
  return `http://${name}${port === 80 ? '' : `:${port}`}${path}`
}

/**
 * True for a host the local network keeps to itself: a private, loopback or link-local IP address, a `.local`,
 * `.lan` or `.home.arpa` name, or a single label. The same rule as `is_lan_host` in sx-link.
 */
export function isLanHost(host: string): boolean {
  if (isIPv4(host)) return lanV4(host)
  if (host.includes(':')) return lanV6(host)
  const h = host.replace(/\.$/, '').toLowerCase()
  if (!h || h.length > 253 || !/^[a-z0-9.-]+$/.test(h)) return false
  if (/^[0-9.]+$/.test(h)) return false
  return !h.includes('.') || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa')
}

function methodOf(plugin: string): ConnectionMethod | undefined {
  try {
    return connectionMethod(plugin as ConnectionId)
  } catch {
    return undefined
  }
}

function isIPv4(host: string): boolean {
  const parts = host.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
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
