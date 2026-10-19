// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a chat's notes go with it, by the address of the model's server, so the save card says it truthfully. This is
// about privacy only; the tools a model is offered go by isLocalModel (surfaces.ts), which is about model size.
// The address is read with the URL class, which keeps userinfo and fragments out of the host, lowercases it, keeps
// IPv6 in brackets and turns shorthand IPv4 (127.1, 2130706433, 0x7f.1) into dotted quads. Anything it cannot place
// counts as remote, so a wrong guess only ever says less private than it is.
import type { PilotConfig } from '@slicerx/contracts'

/** Where notes go with a chat: this computer, a computer on the person's network, or anywhere else. */
export type NotesWhere = 'computer' | 'network' | 'remote'

/** An IPv4 dotted quad as the URL class writes it, or null for anything else. */
function ipv4(host: string): number[] | null {
  const p = host.split('.')
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x))) return null
  const n = p.map(Number)
  return n.every((x) => x <= 255) ? n : null
}

function ipv4Where([a = 0, b = 0]: number[]): NotesWhere {
  // 127/8 loopback. 0.0.0.0 is left out: the server check refuses it, and what it reaches depends on the system.
  if (a === 127) return 'computer'
  // the private ranges (10/8, 172.16/12, 192.168/16), link-local 169.254/16, which no router forwards, and 100.64/10,
  // the shared range Tailscale gives the devices on a tailnet (the server check accepts it the same way)
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return 'network'
  return 'remote'
}

/** The eight groups of an IPv6 address as the URL class writes it (lowercase hex, `::` at most once), or null. */
function ipv6(host: string): number[] | null {
  const halves = host.split('::')
  if (halves.length > 2) return null
  const part = (s: string): string[] => (s ? s.split(':') : [])
  const head = part(halves[0] ?? '')
  const tail = part(halves[1] ?? '')
  const fill = 8 - head.length - tail.length
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail]
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  return groups.map((g) => parseInt(g, 16))
}

function ipv6Where(g: number[]): NotesWhere {
  const [g0 = 0, , , , , g5 = 0, g6 = 0, g7 = 0] = g
  const zeroTo = (n: number): boolean => g.slice(0, n).every((x) => x === 0)
  if (zeroTo(7) && g7 === 1) return 'computer' // ::1
  // IPv4-mapped (::ffff:a.b.c.d, written [::ffff:7f00:1]) goes by the IPv4 address inside
  if (zeroTo(5) && g5 === 0xffff) return ipv4Where([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff])
  // unique local fc00::/7 and link-local fe80::/10
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80) return 'network'
  return 'remote'
}

/** Where a server at `baseUrl` is: a missing, unparseable or non-http address counts as remote. */
export function whereHost(baseUrl: string | undefined): NotesWhere {
  if (!baseUrl) return 'remote'
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    return 'remote'
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'remote'
  // one trailing dot names the same host (localhost.)
  const host = u.hostname.endsWith('.') ? u.hostname.slice(0, -1) : u.hostname
  if (host.startsWith('[') && host.endsWith(']')) {
    const g = ipv6(host.slice(1, -1))
    return g ? ipv6Where(g) : 'remote'
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return 'computer'
  // mDNS names (printer.local) only answer on the local link
  if (host.endsWith('.local')) return 'network'
  const v4 = ipv4(host)
  return v4 ? ipv4Where(v4) : 'remote'
}

/**
 * Where a chat's notes go with it, for the save card: a model the person points at their own server goes by the
 * server's address; every other provider (mimir cloud, an Anthropic or OpenAI key) answers from elsewhere.
 */
export function whereNotesGo(config: Pick<PilotConfig, 'provider' | 'baseUrl'>): NotesWhere {
  return config.provider === 'openai-compatible' ? whereHost(config.baseUrl) : 'remote'
}
