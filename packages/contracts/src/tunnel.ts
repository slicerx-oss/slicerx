// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Printers reached through a remote tunnel instead of the local network. The only kind is Obico's cloud tunnel: the
// person authorizes SlicerX on Obico's page, which hands back `https://<user>:<password>@<id>.tunnels.app.obico.io`,
// and pastes it into the app. parseTunnelEndpoint reads that address with exactly the rules of the hub's
// TunnelEndpoint::parse (packages/connect/src/tunnel.rs); packages/connect/fixtures/tunnel-endpoints.json holds the
// cases both are tested on. The user name and password go to the system keychain and are never shown or logged.

/** The remote tunnels a printer can be reached through. */
export type TunnelKind = 'obico'

/** What a tunnel refused, from its own status codes (Obico: 401, 481, 482, 483) or found before sending anything. */
export type TunnelProblem =
  /** No tunnel access is stored on this computer for the printer. */
  | 'no_access'
  /** 401: the access was revoked, or the printer or account was removed in Obico. */
  | 'access_removed'
  /** 481: this month's free tunnel data is used up. */
  | 'data_limit'
  /** The file is larger than what is left of this month's free tunnel data. */
  | 'file_over_data_limit'
  /** 482: the printer's Obico plugin is not connected to Obico. */
  | 'not_connected'
  /** 483: the printer's Obico plugin did not answer within 30 seconds. */
  | 'timed_out'

export const TUNNEL_PROBLEMS: readonly TunnelProblem[] = ['no_access', 'access_removed', 'data_limit', 'file_over_data_limit', 'not_connected', 'timed_out']

/** Each tunnel problem in plain words, one or two short sentences, for cards, errors and clients. */
export const TUNNEL_PROBLEM_TEXT: Record<TunnelProblem, string> = {
  no_access: 'No Obico access is stored on this computer. Connect the printer through Obico again.',
  access_removed: 'Obico access was removed or revoked. Connect the printer through Obico again.',
  data_limit: "This month's free Obico data is used up. The printer is back after the monthly reset.",
  file_over_data_limit: "This file is bigger than the free Obico data left this month. Nothing was sent.",
  not_connected: "The printer isn't connected to Obico. Check that it's on and its Obico plugin is online.",
  timed_out: "The printer didn't answer through Obico within 30 seconds. Try again shortly.",
}

/** `problem` when it is a tunnel problem this version knows, else null. */
export function tunnelProblemOf(problem: unknown): TunnelProblem | null {
  return typeof problem === 'string' && (TUNNEL_PROBLEMS as readonly string[]).includes(problem) ? (problem as TunnelProblem) : null
}

/** This month's tunnel data, in whole bytes (`printers.tunnel`). */
export interface TunnelUsage {
  usedBytes: number
  /** null when the plan has no cap. */
  capBytes: number | null
  /** null when the plan has no cap. */
  leftBytes: number | null
  unlimited: boolean
  resetInSeconds: number | null
}

/**
 * How a tunnel printer is doing (`PrinterHost.tunnel`, hub method `printers.tunnel`). Never carries the tunnel's
 * user name or password. The camera is off through a tunnel for now.
 */
export interface TunnelReport {
  printerId: string
  tunnel: TunnelKind
  /** The tunnel host, `<id>.tunnels.app.obico.io`. */
  host: string
  camera: false
  /** What the tunnel refused on the last reading, or null. */
  problem: TunnelProblem | null
  /** Whether the last status reading came through; null before the first. */
  connected: boolean | null
  usage: TunnelUsage | null
  /** Obico's failure score for the running print, 0 (looks fine) to 1 (looks failed); null when nothing prints. */
  prediction: { score: number } | null
}

/** Why a pasted tunnel address was refused, as the hub's parser words it. */
export type TunnelPasteProblem = 'scheme' | 'path' | 'port' | 'host' | 'userinfo'

/** Each refusal of a pasted address in plain words. None repeats the address. */
export const TUNNEL_PASTE_TEXT: Record<TunnelPasteProblem, string> = {
  scheme: 'Paste the whole address Obico gave you. It starts with https://.',
  path: 'Paste only the address, without anything after the host.',
  port: 'The address has a port or an IP address. Paste the one Obico gave you.',
  host: 'This is not an Obico tunnel address. It ends in .tunnels.app.obico.io.',
  userinfo: 'The user name or password in the address is incomplete. Copy it again from Obico.',
}

export type TunnelParse =
  /** `credential` is `user:password` for the keychain, when the address carried them. Never show or log it. */
  | { ok: true; kind: TunnelKind; host: string; credential?: string }
  | { ok: false; problem: TunnelPasteProblem }

const OBICO_DOMAIN = '.tunnels.app.obico.io'

/** Unicode White_Space at either end, as Rust's `str::trim` removes it (a byte order mark is not white space). */
const EDGE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase())

/** `host`, lowercased (ASCII only), when it is one DNS label directly under the Obico tunnel domain. */
export function tunnelHost(host: string): string | null {
  const lower = asciiLower(host)
  if (!lower.endsWith(OBICO_DOMAIN)) return null
  const label = lower.slice(0, -OBICO_DOMAIN.length)
  return label.length >= 1 && label.length <= 63 && /^[a-z0-9-]+$/.test(label) && !label.startsWith('-') && !label.endsWith('-') ? lower : null
}

/** Percent-decodes `s` as UTF-8, or null when an escape is malformed, the bytes are not UTF-8 or a control character results. */
function percentDecode(s: string): string | null {
  const bytes = new TextEncoder().encode(s)
  const out: number[] = []
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!
    if (b !== 0x25) {
      out.push(b)
      i += 1
      continue
    }
    if (i + 3 > bytes.length) return null
    const hex = String.fromCharCode(bytes[i + 1]!, bytes[i + 2]!)
    // Rust's from_str_radix also takes a leading +, but every value it then reads is a control character, refused below.
    if (!/^\+?[0-9a-fA-F]{1,2}$/.test(hex)) return null
    out.push(parseInt(hex, 16))
    i += 3
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(out))
  } catch {
    return null
  }
  return /\p{Cc}/u.test(text) ? null : text
}

/**
 * Reads `https://<user>:<password>@<id>.tunnels.app.obico.io` (a trailing `/` is fine) with the hub's rules: https
 * only, no port, path, query or fragment, no IP literal, exactly one label under the Obico tunnel domain. An address
 * without a user name and password parses, with no credential; the paste box asks for the whole address then.
 */
export function parseTunnelEndpoint(url: string): TunnelParse {
  const bad = (problem: TunnelPasteProblem): TunnelParse => ({ ok: false, problem })
  const trimmed = url.replace(EDGE_SPACE, '')
  const sep = trimmed.indexOf('://')
  if (sep < 0) return bad('scheme')
  if (asciiLower(trimmed.slice(0, sep)) !== 'https') return bad('scheme')
  const rest = trimmed.slice(sep + 3)
  const cut = rest.search(/[/?#]/)
  const authority = cut < 0 ? rest : rest.slice(0, cut)
  const tail = cut < 0 ? '' : rest.slice(cut)
  if (!(tail === '' || tail === '/')) return bad('path')
  const at = authority.lastIndexOf('@')
  const userinfo = at < 0 ? null : authority.slice(0, at)
  const hostport = at < 0 ? authority : authority.slice(at + 1)
  if (/[:[\]]/.test(hostport)) return bad('port')
  const host = tunnelHost(hostport)
  if (!host) return bad('host')
  if (userinfo === null) return { ok: true, kind: 'obico', host }
  const colon = userinfo.indexOf(':')
  if (colon < 0) return bad('userinfo')
  const user = percentDecode(userinfo.slice(0, colon))
  const pass = percentDecode(userinfo.slice(colon + 1))
  if (user === null || pass === null || user === '' || pass === '' || user.includes(':')) return bad('userinfo')
  return { ok: true, kind: 'obico', host, credential: `${user}:${pass}` }
}
