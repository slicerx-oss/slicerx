// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The paste box reads an Obico tunnel address with the hub's rules. Every case in the shared fixture is also run by
// the Rust tunnel tests (packages/connect/src/tunnel/tests.rs), so the app and the hub never disagree.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseTunnelEndpoint, TUNNEL_PASTE_TEXT, type TunnelPasteProblem } from '@slicerx/contracts'

interface Case {
  input: string
  host: string | null
  credential: boolean
  problem: TunnelPasteProblem | null
  note?: string
}

const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../connect/fixtures/tunnel-endpoints.json'), 'utf8')) as { cases: Case[] }

describe('parseTunnelEndpoint', () => {
  it('has the shared cases', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(40)
  })

  for (const c of fixture.cases) {
    it(`${JSON.stringify(c.input)}${c.note ? ` (${c.note})` : ''}`, () => {
      const r = parseTunnelEndpoint(c.input)
      if (c.problem === null) {
        expect(r.ok).toBe(true)
        if (!r.ok) return
        expect(r.host).toBe(c.host)
        expect(r.credential !== undefined).toBe(c.credential)
      } else {
        expect(r.ok).toBe(false)
        if (r.ok) return
        expect(r.problem).toBe(c.problem)
      }
    })
  }

  it('decodes the user name and password and keeps them together for the keychain', () => {
    const r = parseTunnelEndpoint('https://us%40er:p%2Fss@abc.tunnels.app.obico.io')
    expect(r.ok && r.credential).toBe('us@er:p/ss')
  })

  it('never puts the address or the password in a refusal', () => {
    for (const input of ['https://u1:s3cretpw@abc.tunnels.app.obico.io:8443', 'http://u1:s3cretpw@abc.tunnels.app.obico.io', 'https://u1:s3cretpw@evil.example']) {
      const r = parseTunnelEndpoint(input)
      expect(r.ok).toBe(false)
      expect(JSON.stringify(r)).not.toContain('s3cretpw')
    }
  })

  it('has one plain sentence for each refusal', () => {
    for (const [problem, text] of Object.entries(TUNNEL_PASTE_TEXT)) {
      expect(text, problem).toMatch(/^[A-Z].*\.$/)
      expect(text.length, problem).toBeLessThanOrEqual(120)
      expect(text, problem).not.toMatch(/[\u2013\u2014]/)
    }
  })
})
