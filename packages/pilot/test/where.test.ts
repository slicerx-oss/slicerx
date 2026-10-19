// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a chat's notes go, by the model server's address: this computer, the person's network, or anywhere else. An
// address that only looks local, or that cannot be read, counts as remote.
import { describe, expect, it } from 'vitest'
import { isLocalModel } from '../src/surfaces'
import { whereHost, whereNotesGo, type NotesWhere } from '../src/memory/where'

const cases = (rows: [string | undefined, NotesWhere][]): void => {
  for (const [url, want] of rows) expect(whereHost(url), String(url)).toBe(want)
}

describe('whereHost', () => {
  it('loopback is this computer', () => {
    cases([
      ['http://localhost:11434/v1', 'computer'],
      ['http://ollama.localhost:11434/v1', 'computer'],
      ['http://127.0.0.1:1234/v1', 'computer'],
      ['http://127.8.9.10/v1', 'computer'],
      ['https://localhost/v1', 'computer'],
      ['http://[::1]:11434/v1', 'computer'],
    ])
  })

  it('the private ranges, the tailnet range, link-local and mDNS names are the network', () => {
    cases([
      ['http://10.0.0.5:8080/v1', 'network'],
      ['http://10.255.255.255/v1', 'network'],
      ['http://172.16.0.1/v1', 'network'],
      ['http://172.31.255.254/v1', 'network'],
      ['http://192.168.1.20:11434/v1', 'network'],
      ['http://169.254.10.20/v1', 'network'],
      ['http://100.64.0.1:11434/v1', 'network'],
      ['http://100.101.102.103/v1', 'network'],
      ['http://100.127.255.254/v1', 'network'],
      ['http://studio.local:1234/v1', 'network'],
      ['http://[fd12:3456:789a::1]:11434/v1', 'network'],
      ['http://[fc00::1]/v1', 'network'],
      ['http://[fe80::1]/v1', 'network'],
      ['http://[febf::1]/v1', 'network'],
    ])
  })

  it('addresses next to the private ranges are remote', () => {
    cases([
      ['http://172.15.0.1/v1', 'remote'],
      ['http://172.32.0.1/v1', 'remote'],
      ['http://192.169.0.1/v1', 'remote'],
      ['http://169.253.0.1/v1', 'remote'],
      ['http://100.63.255.255/v1', 'remote'],
      ['http://100.128.0.0/v1', 'remote'],
      ['http://11.0.0.1/v1', 'remote'],
      ['http://8.8.8.8/v1', 'remote'],
      ['http://[fec0::1]/v1', 'remote'],
      ['http://[fe00::1]/v1', 'remote'],
      ['http://[2001:db8::1]/v1', 'remote'],
      ['https://api.example.com/v1', 'remote'],
    ])
  })

  it('0.0.0.0 and the unspecified IPv6 address are remote', () => {
    cases([
      ['http://0.0.0.0:11434/v1', 'remote'],
      ['http://0/v1', 'remote'],
      ['http://[::]:11434/v1', 'remote'],
    ])
  })

  it('reads the host the URL class reads, not the text before an @ or after a #', () => {
    cases([
      ['http://localhost@evil.com/v1', 'remote'],
      ['http://127.0.0.1@evil.com/v1', 'remote'],
      ['http://user:pass@localhost:11434/v1', 'computer'],
      ['http://evil.com#@localhost', 'remote'],
      ['http://evil.com?@localhost', 'remote'],
      ['http://evil.com\\@localhost', 'remote'],
    ])
  })

  it('names that only look local are remote', () => {
    cases([
      ['http://localhost.evil.com/v1', 'remote'],
      ['http://127.0.0.1.nip.io/v1', 'remote'],
      ['http://10.0.0.1.example.com/v1', 'remote'],
      ['http://192.168.1.1.evil/v1', 'remote'],
      ['http://mylocalhost/v1', 'remote'],
      ['http://evil-localhost/v1', 'remote'],
      ['http://local/v1', 'remote'],
    ])
  })

  it('IPv4-mapped IPv6 goes by the IPv4 address inside', () => {
    expect(new URL('http://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]')
    cases([
      ['http://[::ffff:127.0.0.1]:11434/v1', 'computer'],
      ['http://[::ffff:7f00:1]/v1', 'computer'],
      ['http://[::ffff:192.168.1.5]/v1', 'network'],
      ['http://[::ffff:10.1.2.3]/v1', 'network'],
      ['http://[::ffff:100.64.0.1]/v1', 'network'],
      ['http://[::ffff:100.128.0.0]/v1', 'remote'],
      ['http://[::ffff:8.8.8.8]/v1', 'remote'],
      // the old IPv4-compatible form is not mapped
      ['http://[::127.0.0.1]/v1', 'remote'],
    ])
  })

  it('uppercase hosts and one trailing dot name the same host', () => {
    cases([
      ['http://LOCALHOST:11434/v1', 'computer'],
      ['http://LocalHost./v1', 'computer'],
      ['http://localhost./v1', 'computer'],
      ['http://127.0.0.1./v1', 'computer'],
      ['http://Studio.LOCAL/v1', 'network'],
      ['http://[::FFFF:7F00:1]/v1', 'computer'],
      ['http://LOCALHOST.EVIL.COM/v1', 'remote'],
    ])
  })

  it('shorthand and numeric IPv4 go by what the URL class makes of them', () => {
    expect(new URL('http://127.1/').hostname).toBe('127.0.0.1')
    expect(new URL('http://2130706433/').hostname).toBe('127.0.0.1')
    expect(new URL('http://0x7f.1/').hostname).toBe('127.0.0.1')
    expect(new URL('http://3232235777/').hostname).toBe('192.168.1.1')
    cases([
      ['http://127.1:11434/v1', 'computer'],
      ['http://2130706433/v1', 'computer'],
      ['http://0x7f000001/v1', 'computer'],
      ['http://0177.0.0.1/v1', 'computer'],
      ['http://10.1/v1', 'network'],
      ['http://3232235777/v1', 'network'],
      ['http://134744072/v1', 'remote'],
    ])
  })

  it('a missing, empty, unreadable or non-http address is remote', () => {
    cases([
      [undefined, 'remote'],
      ['', 'remote'],
      ['localhost:11434', 'remote'],
      ['//localhost:11434/v1', 'remote'],
      ['not a url', 'remote'],
      ['http://', 'remote'],
      ['http://[::1/v1', 'remote'],
      ['http://256.0.0.1/v1', 'remote'],
      ['ftp://localhost/v1', 'remote'],
      ['file:///home/me/model', 'remote'],
      ['ws://localhost:11434/v1', 'remote'],
    ])
  })
})

describe('whereNotesGo', () => {
  it('a server the person runs goes by its address; every other provider is remote whatever its address', () => {
    expect(whereNotesGo({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' })).toBe('computer')
    expect(whereNotesGo({ provider: 'openai-compatible', baseUrl: 'http://192.168.1.20:11434/v1' })).toBe('network')
    expect(whereNotesGo({ provider: 'openai-compatible', baseUrl: 'https://llm.example.com/v1' })).toBe('remote')
    expect(whereNotesGo({ provider: 'openai-compatible' })).toBe('remote')
    for (const provider of ['openai', 'anthropic', 'mimir-cloud', 'scripted']) expect(whereNotesGo({ provider, baseUrl: 'http://localhost:11434/v1' }), provider).toBe('remote')
  })

  it('leaves isLocalModel as it is: any server the person runs still gets the shorter tool list', () => {
    for (const baseUrl of ['http://localhost:11434/v1', 'http://192.168.1.20/v1', 'https://llm.example.com/v1', undefined]) {
      expect(isLocalModel({ provider: 'openai-compatible', ...(baseUrl ? { baseUrl } : {}) } as { provider: string })).toBe(true)
    }
  })
})
