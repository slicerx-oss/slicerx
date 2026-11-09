// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model links reach public internet addresses only: the first URL and every redirect hop are checked (http or https,
// every address the host resolves to), and the connection goes to the checked address. DNS and the transport are
// scripted here; nothing touches the network.
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveModel, type PathPolicy } from '../src/models'
import { blockedAddress, guardedGet, pinnedGet, type PinnedGet, type ResolvedAddress } from '../src/url-guard'

const PUBLIC = '203.0.113.10'
const STL = 'solid x\nendsolid x\n'

/** A resolver from a table of host names, and a transport that answers by URL and records where it connected. */
function scripted(dns: Record<string, string[]>, answers: Record<string, () => Response>) {
  const connected: { url: string; address: string }[] = []
  const lookups: string[] = []
  const lookup = async (host: string): Promise<ResolvedAddress[]> => {
    lookups.push(host)
    const found = dns[host]
    if (!found) throw new Error(`ENOTFOUND ${host}`)
    return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  const get: PinnedGet = async (url, address) => {
    connected.push({ url: url.href, address: address.address })
    const answer = answers[url.href]
    if (!answer) throw new Error(`no scripted answer for ${url.href}`)
    return answer()
  }
  return { lookup, get, connected, lookups }
}

const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } })
const ok = (body = STL) => () => new Response(body)

function policy(s: { lookup: NonNullable<PathPolicy['lookup']>; get: NonNullable<PathPolicy['get']> }): PathPolicy {
  return { allowDirs: undefined, outDir: mkdtempSync(join(tmpdir(), 'slicerx-url-guard-')), allowUrls: true, lookup: s.lookup, get: s.get }
}

describe('blockedAddress', () => {
  const blocked: [string, RegExp][] = [
    ['127.0.0.1', /loopback/],
    ['127.255.0.9', /loopback/],
    ['::1', /loopback/],
    ['10.1.2.3', /private/],
    ['172.16.0.1', /private/],
    ['172.31.255.254', /private/],
    ['192.168.1.20', /private/],
    ['100.64.0.1', /CGNAT/],
    ['100.127.255.254', /CGNAT/],
    ['169.254.10.10', /link-local/],
    ['169.254.169.254', /cloud metadata/],
    ['168.63.129.16', /cloud metadata/],
    ['fd00:ec2::254', /cloud metadata/],
    ['fc00::1', /unique local/],
    ['fdab:1234::5', /unique local/],
    ['fe80::1', /link-local/],
    ['febf::1', /link-local/],
    ['0.0.0.0', /unspecified/],
    ['::', /unspecified/],
    ['::ffff:127.0.0.1', /IPv4-mapped/],
    ['::ffff:8.8.8.8', /IPv4-mapped/],
    ['::ffff:7f00:1', /IPv4-mapped/],
    ['::127.0.0.1', /IPv4-compatible/],
    ['64:ff9b::a9fe:a9fe', /NAT64 address for a cloud metadata address/],
    ['2002:c0a8:0101::1', /6to4 address for a private address/],
    ['224.0.0.1', /multicast/],
    ['ff02::1', /multicast/],
    ['255.255.255.255', /reserved/],
  ]
  for (const [ip, why] of blocked) it(`refuses ${ip}`, () => expect(blockedAddress(ip)).toMatch(why))

  for (const ip of ['8.8.8.8', '203.0.113.10', '100.63.255.255', '100.128.0.1', '172.32.0.1', '169.253.0.1', '2606:4700::1111', '64:ff9b::808:808', '2002:0808:0808::1']) {
    it(`allows ${ip}`, () => expect(blockedAddress(ip)).toBeUndefined())
  }
})

describe('model links', () => {
  it('downloads from a public address, connecting to the address it checked', async () => {
    const s = scripted({ 'models.example': [PUBLIC] }, { 'https://models.example/parts/cube.stl': ok() })
    const file = await resolveModel(policy(s), 'https://models.example/parts/cube.stl')
    expect(readFileSync(file, 'utf8')).toBe(STL)
    expect(file.endsWith('cube.stl')).toBe(true)
    expect(s.connected).toEqual([{ url: 'https://models.example/parts/cube.stl', address: PUBLIC }])
  })

  it('follows a redirect to another public host, checking that host too', async () => {
    const s = scripted(
      { 'models.example': [PUBLIC], 'cdn.example': ['198.51.100.7'] },
      { 'https://models.example/cube.stl': redirect('https://cdn.example/blob/123'), 'https://cdn.example/blob/123': ok() },
    )
    const file = await resolveModel(policy(s), 'https://models.example/cube.stl')
    expect(file.endsWith('cube.stl')).toBe(true)
    expect(s.lookups).toEqual(['models.example', 'cdn.example'])
    expect(s.connected.map((c) => c.address)).toEqual([PUBLIC, '198.51.100.7'])
  })

  const privateHosts: [string, string][] = [
    ['loopback', '127.0.0.1'],
    ['private 10/8', '10.0.0.5'],
    ['private 172.16/12', '172.20.1.1'],
    ['private 192.168/16', '192.168.0.10'],
    ['CGNAT', '100.100.100.200'],
    ['link-local', '169.254.1.1'],
    ['cloud metadata', '169.254.169.254'],
    ['IPv6 loopback', '::1'],
    ['IPv6 unique local', 'fd12::1'],
    ['IPv6 link-local', 'fe80::abcd'],
    ['IPv6 cloud metadata', 'fd00:ec2::254'],
    ['IPv4-mapped IPv6', '::ffff:10.0.0.1'],
    ['unspecified', '0.0.0.0'],
  ]
  for (const [what, address] of privateHosts) {
    it(`refuses a host that resolves to ${what} (${address}) before connecting`, async () => {
      const s = scripted({ 'inside.example': [address] }, { 'http://inside.example/a.stl': ok() })
      await expect(resolveModel(policy(s), 'http://inside.example/a.stl')).rejects.toMatchObject({ code: 'path_not_allowed' })
      expect(s.connected).toEqual([])
    })
  }

  it('refuses an address written into the link, in any spelling the URL parser reads as one', async () => {
    for (const link of ['http://127.0.0.1/a.stl', 'http://[::1]/a.stl', 'http://2130706433/a.stl', 'http://0x7f.1/a.stl', 'http://169.254.169.254/latest/a.stl', 'http://[::ffff:169.254.169.254]/a.stl', 'http://[fd00:ec2::254]/a.stl']) {
      const s = scripted({}, {})
      await expect(resolveModel(policy(s), link), link).rejects.toMatchObject({ code: 'path_not_allowed' })
      expect(s.lookups).toEqual([])
      expect(s.connected).toEqual([])
    }
  })

  it('refuses a host when any address it resolves to is private', async () => {
    const s = scripted({ 'mixed.example': [PUBLIC, '10.0.0.1'] }, { 'https://mixed.example/a.stl': ok() })
    await expect(resolveModel(policy(s), 'https://mixed.example/a.stl')).rejects.toMatchObject({ code: 'path_not_allowed' })
    expect(s.connected).toEqual([])
  })

  it('refuses a redirect to a private address and never connects to it', async () => {
    const s = scripted(
      { 'models.example': [PUBLIC], 'rebind.example': ['192.168.1.1'] },
      {
        'https://models.example/a.stl': redirect('http://169.254.169.254/latest/meta-data/'),
        'https://models.example/b.stl': redirect('http://rebind.example/b.stl', 307),
        'https://models.example/c.stl': redirect('/d.stl'),
        'https://models.example/d.stl': redirect('http://[::1]:8080/c.stl', 301),
      },
    )
    for (const link of ['https://models.example/a.stl', 'https://models.example/b.stl', 'https://models.example/c.stl']) {
      await expect(resolveModel(policy(s), link), link).rejects.toMatchObject({ code: 'path_not_allowed' })
    }
    expect(s.connected.every((c) => c.address === PUBLIC)).toBe(true)
  })

  it('checks each hop with a fresh lookup, so a name that changes its answer is caught', async () => {
    let calls = 0
    const s = scripted({}, { 'https://flip.example/a.stl': redirect('https://flip.example/b.stl'), 'https://flip.example/b.stl': ok() })
    const lookup = async (): Promise<ResolvedAddress[]> => [{ address: calls++ === 0 ? PUBLIC : '127.0.0.1', family: 4 }]
    await expect(resolveModel(policy({ lookup, get: s.get }), 'https://flip.example/a.stl')).rejects.toMatchObject({ code: 'path_not_allowed' })
    expect(s.connected).toEqual([{ url: 'https://flip.example/a.stl', address: PUBLIC }])
  })

  it('refuses a scheme other than http or https, in the link or in a redirect', async () => {
    const s = scripted({ 'models.example': [PUBLIC] }, { 'https://models.example/a.stl': redirect('file:///etc/passwd'), 'https://models.example/b.stl': redirect('ftp://models.example/b.stl') })
    for (const link of ['ftp://models.example/a.stl', 'file:///etc/a.stl', 'gopher://models.example/a.stl']) {
      await expect(resolveModel(policy(s), link), link).rejects.toMatchObject({ code: 'unsupported_format' })
    }
    for (const link of ['https://models.example/a.stl', 'https://models.example/b.stl']) {
      await expect(resolveModel(policy(s), link), link).rejects.toMatchObject({ code: 'unsupported_format' })
    }
    expect(s.connected.map((c) => c.url)).toEqual(['https://models.example/a.stl', 'https://models.example/b.stl'])
  })

  it('stops after five redirects', async () => {
    const answers: Record<string, () => Response> = {}
    for (let i = 0; i < 10; i++) answers[`https://models.example/${i}.stl`] = redirect(`https://models.example/${i + 1}.stl`)
    const s = scripted({ 'models.example': [PUBLIC] }, answers)
    await expect(resolveModel(policy(s), 'https://models.example/0.stl')).rejects.toMatchObject({ code: 'download_failed' })
    expect(s.connected).toHaveLength(6)
  })

  it('reports a host that does not resolve as a failed download', async () => {
    const s = scripted({}, {})
    await expect(guardedGet(new URL('https://nowhere.example/a.stl'), { lookup: s.lookup, get: s.get, signal: AbortSignal.timeout(1000) })).rejects.toMatchObject({ code: 'download_failed' })
  })
})

describe('pinnedGet', () => {
  it('connects to the address it is given, whatever the name would resolve to, and leaves redirects to the caller', async () => {
    const seen: string[] = []
    const server = createServer((req, res) => {
      seen.push(`${req.headers.host} ${req.url}`)
      if (req.url === '/moved') res.writeHead(302, { location: 'http://elsewhere.invalid/' }).end()
      else res.end(STL)
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    try {
      const port = (server.address() as AddressInfo).port
      // .invalid never resolves, so a response proves the socket went to the pinned address.
      const res = await pinnedGet(new URL(`http://pinned.invalid:${port}/cube.stl`), { address: '127.0.0.1', family: 4 }, AbortSignal.timeout(5000))
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(STL)
      const moved = await pinnedGet(new URL(`http://pinned.invalid:${port}/moved`), { address: '127.0.0.1', family: 4 }, AbortSignal.timeout(5000))
      expect(moved.status).toBe(302)
      expect(moved.headers.get('location')).toBe('http://elsewhere.invalid/')
      expect(seen).toEqual([`pinned.invalid:${port} /cube.stl`, `pinned.invalid:${port} /moved`])
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })
})
