// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Fetching a model from a link the client gave, without letting the link reach this computer, the local network or a
// cloud metadata service. Every hop (the first URL and each redirect) is checked: http or https only, the host resolved
// here, every address it resolves to checked, and the connection made to that checked address, so a name that answers
// differently the second time (DNS rebinding) never gets a say.
import { lookup as dnsLookup } from 'node:dns/promises'
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Readable } from 'node:stream'
import { ToolInputError } from './errors'

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

/** Every address a host name resolves to. */
export type HostLookup = (hostname: string) => Promise<ResolvedAddress[]>

/** One GET of `url` over a connection to exactly `address`. It never follows a redirect itself. */
export type PinnedGet = (url: URL, address: ResolvedAddress, signal: AbortSignal) => Promise<Response>

export const MAX_REDIRECTS = 5

const REDIRECTS = new Set([301, 302, 303, 307, 308])

/** Ranges a model link may not reach, each with the words a refusal uses. */
const RANGES: [string, number, 'ipv4' | 'ipv6', string][] = [
  ['0.0.0.0', 8, 'ipv4', 'an unspecified address'],
  ['10.0.0.0', 8, 'ipv4', 'a private address'],
  ['100.64.0.0', 10, 'ipv4', 'a shared (CGNAT) address'],
  ['127.0.0.0', 8, 'ipv4', 'a loopback address'],
  ['169.254.169.254', 32, 'ipv4', 'a cloud metadata address'],
  ['168.63.129.16', 32, 'ipv4', 'a cloud metadata address'],
  ['169.254.0.0', 16, 'ipv4', 'a link-local address'],
  ['172.16.0.0', 12, 'ipv4', 'a private address'],
  ['192.0.0.0', 24, 'ipv4', 'a reserved address'],
  ['192.0.2.0', 24, 'ipv4', 'a documentation address'],
  ['192.88.99.0', 24, 'ipv4', 'a 6to4 relay address'],
  ['192.168.0.0', 16, 'ipv4', 'a private address'],
  ['198.18.0.0', 15, 'ipv4', 'a reserved address'],
  ['198.51.100.0', 24, 'ipv4', 'a documentation address'],
  ['203.0.113.0', 24, 'ipv4', 'a documentation address'],
  ['224.0.0.0', 4, 'ipv4', 'a multicast address'],
  ['240.0.0.0', 4, 'ipv4', 'a reserved address'],
  ['::', 128, 'ipv6', 'an unspecified address'],
  ['::1', 128, 'ipv6', 'a loopback address'],
  ['fd00:ec2::254', 128, 'ipv6', 'a cloud metadata address'],
  ['64:ff9b:1::', 48, 'ipv6', 'a local-use NAT64 address'],
  ['100::', 64, 'ipv6', 'a discard address'],
  ['2001::', 32, 'ipv6', 'a Teredo address'],
  ['2001:10::', 28, 'ipv6', 'a reserved (ORCHID) address'],
  ['2001:20::', 28, 'ipv6', 'a reserved (ORCHIDv2) address'],
  ['2001:db8::', 32, 'ipv6', 'a documentation address'],
  ['3fff::', 20, 'ipv6', 'a documentation address'],
  ['fc00::', 7, 'ipv6', 'a private (unique local) address'],
  ['fe80::', 10, 'ipv6', 'a link-local address'],
  ['fec0::', 10, 'ipv6', 'a site-local address'],
  ['ff00::', 8, 'ipv6', 'a multicast address'],
]

const LISTS = RANGES.map(([net, prefix, type, words]) => {
  const list = new BlockList()
  list.addSubnet(net, prefix, type)
  return { list, type, words }
})

/** The eight 16-bit groups of an IPv6 address, or undefined when it is not one. */
function groups(ip: string): number[] | undefined {
  if (isIP(ip) !== 6) return undefined
  let text = ip.split('%')[0]!
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split('.').map(Number) as [number, number, number, number]
    text = `${text.slice(0, -dotted[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined]
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0')
  return [...left, ...fill, ...right].map((g) => parseInt(g, 16))
}

/** The IPv4 address an IPv6 address carries (mapped, compatible, NAT64 or 6to4), when it carries one. */
function carriedV4(g: number[]): { v4: string; how: string } | undefined {
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return { v4: v4(g[6]!, g[7]!), how: 'an IPv4-mapped address' }
  if (g.slice(0, 6).every((x) => x === 0)) return { v4: v4(g[6]!, g[7]!), how: 'an IPv4-compatible address' }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return { v4: v4(g[6]!, g[7]!), how: 'a NAT64 address' }
  if (g[0] === 0x2002) return { v4: v4(g[1]!, g[2]!), how: 'a 6to4 address' }
  return undefined
}

/** Why a model link may not connect to `ip`, or undefined when it may. */
export function blockedAddress(ip: string): string | undefined {
  const bare = ip.replace(/^\[|\]$/g, '')
  const family = isIP(bare)
  if (family === 0) return 'not an IP address'
  if (family === 6) {
    const g = groups(bare)!
    // :: and ::1 first, so they read as unspecified and loopback, not as IPv4-compatible.
    for (const { list, type, words } of LISTS) if (type === 'ipv6' && list.check(bare, 'ipv6')) return words
    const carried = carriedV4(g)
    if (carried) {
      // An IPv4-mapped or IPv4-compatible address has no business in a public link's DNS answer.
      if (carried.how === 'an IPv4-mapped address' || carried.how === 'an IPv4-compatible address') return carried.how
      const inner = blockedAddress(carried.v4)
      if (inner) return `${carried.how} for ${inner}`
    }
    return undefined
  }
  for (const { list, type, words } of LISTS) if (type === 'ipv4' && list.check(bare, 'ipv4')) return words
  return undefined
}

export const systemLookup: HostLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }))

/**
 * A GET over node's http or https, its socket connected to `address` whatever DNS says now; TLS still checks the name.
 * `ca` replaces the trusted roots (tests, with a certificate of their own).
 */
export const pinnedTransport = (tls: { ca?: string } = {}): PinnedGet => (url, address, signal) =>
  new Promise<Response>((resolveResponse, reject) => {
    const lookup: LookupFunction = (_host, opts, cb) => {
      if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: ResolvedAddress[]) => void)(null, [address])
      else cb(null, address.address, address.family)
    }
    const https = url.protocol === 'https:'
    const send = https ? httpsRequest : httpRequest
    // A fresh agent each time: the shared one may go through a proxy from the environment (NODE_USE_ENV_PROXY), and
    // its keep-alive pool is keyed by host name, so a socket to an address checked for an earlier hop could be reused.
    const agent = https ? new HttpsAgent({ keepAlive: false, ...(tls.ca ? { ca: tls.ca } : {}) }) : new HttpAgent({ keepAlive: false })
    const req = send(url, { method: 'GET', lookup, signal, agent, headers: { accept: '*/*' } }, (res: IncomingMessage) => {
      const headers = new Headers()
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) for (const one of v) headers.append(k, one)
        else if (v !== undefined) headers.set(k, v)
      }
      const status = res.statusCode ?? 502
      const bodyless = status === 204 || status === 205 || status === 304 || REDIRECTS.has(status)
      if (bodyless) res.resume()
      resolveResponse(new Response(bodyless ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers }))
    })
    req.on('error', reject)
    req.end()
  })

export const pinnedGet: PinnedGet = pinnedTransport()

/** The addresses a hop may connect to, all checked; refused when the scheme is wrong or any address is off limits. */
async function checkedAddress(url: URL, lookup: HostLookup): Promise<ResolvedAddress> {
  // http.request would send these as Basic auth on every hop the link leads to; a model link has no business with them.
  if (url.username || url.password) throw new ToolInputError('Model links with a user name or password are not supported; pass a link without them.', 'invalid_input')
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolInputError(`Only http and https links are supported for models; ${url.href} is ${url.protocol.replace(/:$/, '')}.`, 'unsupported_format')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const literal = isIP(host)
  let addresses: ResolvedAddress[]
  if (literal) addresses = [{ address: host, family: literal === 6 ? 6 : 4 }]
  else {
    try {
      addresses = await lookup(host)
    } catch (e) {
      throw new ToolInputError(`Download failed: ${host} could not be resolved (${e instanceof Error ? e.message : String(e)}).`, 'download_failed')
    }
  }
  if (!addresses.length) throw new ToolInputError(`Download failed: ${host} has no address.`, 'download_failed')
  for (const a of addresses) {
    const why = blockedAddress(a.address)
    if (why) throw new ToolInputError(`${url.href} is refused: ${host === a.address ? 'it is' : `${host} resolves to ${a.address},`} ${why}. Model links must reach a public internet address.`, 'path_not_allowed')
  }
  return addresses[0]!
}

/**
 * GETs `url`, following up to MAX_REDIRECTS redirects by hand, checking each hop before connecting to it. Returns the
 * final response, which is not a redirect.
 */
export async function guardedGet(url: URL, opts: { lookup?: HostLookup; get?: PinnedGet; signal: AbortSignal }): Promise<Response> {
  const lookup = opts.lookup ?? systemLookup
  const get = opts.get ?? pinnedGet
  let at = url
  for (let hop = 0; ; hop++) {
    const address = await checkedAddress(at, lookup)
    const res = await get(at, address, opts.signal)
    if (!REDIRECTS.has(res.status)) return res
    await res.body?.cancel().catch(() => {})
    const location = res.headers.get('location')
    if (!location) throw new ToolInputError(`Download failed: HTTP ${res.status} with no Location for ${at.href}`, 'download_failed')
    if (hop >= MAX_REDIRECTS) throw new ToolInputError(`Download failed: ${url.href} redirected more than ${MAX_REDIRECTS} times.`, 'download_failed')
    let next: URL
    try {
      next = new URL(location, at)
    } catch {
      throw new ToolInputError(`Download failed: ${at.href} redirected to a bad link.`, 'download_failed')
    }
    at = next
  }
}
