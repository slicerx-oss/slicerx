// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's memory over the app link: facts read back with secrets hidden, a fact added through the store, a secret never
// kept, and a plain "memory unavailable" while no store is registered.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { redactSecrets } from '../src/app-link/memory-secrets'
import { APP_LINK_METHODS, type LinkError, runCall } from '../src/app-link/methods'
import { setMemoryProvider, type MemoryFact, type MemoryProvider } from '../src/app-link/mimir-memory'

const FACTS: MemoryFact[] = [
  { id: 'f1', kind: 'printer', text: 'A Bambu Lab P1S with a 0.4 mm nozzle, access code 12345678', data: { nozzleMm: 0.4, accessCode: '87654321' }, updatedAt: 10 },
  { id: 'f2', kind: 'filament', text: 'Prints PLA at 215 C on the textured plate', updatedAt: 30 },
  { id: 'f3', kind: 'preference', text: 'Uses the key sk-abcdefghijklmnopqrstuvwxyz0123 for scripts', data: { serial: '01S00C123456789', note: 'printer 01P00A123456789 in the garage' }, updatedAt: 20 },
]

function memory(facts = FACTS) {
  const kept: MemoryFact[] = []
  const p: MemoryProvider = {
    list: vi.fn(async (kind) => facts.filter((f) => !kind || f.kind === kind)),
    remember: vi.fn(async (f) => {
      const fact = { id: `n${kept.length + 1}`, ...f, updatedAt: 99 }
      kept.push(fact)
      return fact
    }),
  }
  setMemoryProvider(p)
  return { p, kept }
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as LinkError)

afterEach(() => setMemoryProvider(null))

describe('mimir memory over the app link', () => {
  it('reads with the read class and adds with the edit class', () => {
    expect(APP_LINK_METHODS['mimir.memory']).toBe('read')
    expect(APP_LINK_METHODS['mimir.memory_remember']).toBe('edit')
  })

  it('says memory is unavailable while no store is registered', async () => {
    for (const [method, args] of [['mimir.memory', {}], ['mimir.memory_remember', { kind: 'size', text: 'Hands are 9 cm across' }]] as const) {
      const e = await refusal(runCall(method, args))
      expect(e?.code, method).toBe('not_ready')
      expect(e?.message).toMatch(/^memory unavailable: /)
    }
  })

  it('reads the facts newest first, with access codes, keys and serials hidden', async () => {
    memory()
    const out = (await runCall('mimir.memory', {})) as { facts: MemoryFact[]; hidden: number }
    expect(out.facts.map((f) => f.id)).toEqual(['f2', 'f3', 'f1'])
    expect(out.hidden).toBe(2)
    const json = JSON.stringify(out)
    for (const secret of ['12345678', '87654321', 'sk-abcdefghijklmnopqrstuvwxyz0123', '01S00C123456789', '01P00A123456789']) expect(json).not.toContain(secret)
    expect(out.facts[2]).toEqual({ id: 'f1', kind: 'printer', text: 'A Bambu Lab P1S with a 0.4 mm nozzle, access code [hidden]', data: { nozzleMm: 0.4, accessCode: '[hidden]' }, updatedAt: 10 })
    expect(out.facts[0]).toEqual(FACTS[1])
    expect(out.facts[1]!.data).toEqual({ serial: '[hidden]', note: 'printer [hidden] in the garage' })
  })

  it('reads one kind', async () => {
    const { p } = memory()
    const out = (await runCall('mimir.memory', { kind: 'filament' })) as { facts: MemoryFact[] }
    expect(p.list).toHaveBeenCalledWith('filament')
    expect(out.facts.map((f) => f.id)).toEqual(['f2'])
    expect((await refusal(runCall('mimir.memory', { kind: 'secrets' })))?.code).toBe('invalid_input')
    expect((await refusal(runCall('mimir.memory', { query: 'pla' })))?.code).toBe('invalid_input')
  })

  it('adds a fact and reads it back', async () => {
    const { kept } = memory()
    const out = await runCall('mimir.memory_remember', { kind: 'outcome', text: '  PETG at 0.2 mm layers worked for the hinge  ', data: { layerMm: 0.2, material: 'PETG' } })
    expect(out).toEqual({ fact: { id: 'n1', kind: 'outcome', text: 'PETG at 0.2 mm layers worked for the hinge', data: { layerMm: 0.2, material: 'PETG' }, updatedAt: 99 } })
    expect(kept).toHaveLength(1)
  })

  it('never keeps a secret, and checks the fact before the store sees it', async () => {
    const { p } = memory()
    for (const args of [
      { kind: 'printer', text: 'The access code is 1234abcd' },
      { kind: 'preference', text: 'My key is sk-abcdefghijklmnopqrstuvwxyz0123' },
      { kind: 'printer', text: 'The X1C', data: { serialNumber: '00M09A123456789' } },
      { kind: 'printer', text: 'The A1', data: { name: 'garage, SN: 03919A123456789' } },
    ]) {
      const e = await refusal(runCall('mimir.memory_remember', args))
      expect(e?.code, args.text).toBe('refused')
      expect(e?.message).toMatch(/does not keep secrets/)
    }
    for (const args of [{ kind: 'mood', text: 'x' }, { kind: 'size', text: '' }, { kind: 'size', text: 'x'.repeat(501) }, { kind: 'size', text: 'ok', data: [1] }, { kind: 'size', text: 'ok', extra: true }]) {
      expect((await refusal(runCall('mimir.memory_remember', args)))?.code, JSON.stringify(args)).toBe('invalid_input')
    }
    expect(p.remember).not.toHaveBeenCalled()
  })
})

describe('the memory secrets filter', () => {
  it('hides keys from the edition config patterns, private keys, access codes and serials', () => {
    for (const [text, want] of [
      ['key sk-abcdefghijklmnopqrstuvwxyz0123 here', 'key [hidden] here'],
      ['stripe sk_live_abcdefghij1234', 'stripe [hidden]'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY----- done', '[hidden] done'],
      ['access code: 12345678', 'access code: [hidden]'],
      ['LAN code is 9f8e7d6c', 'LAN code is [hidden]'],
      ['serial number 01S00C123456789', 'serial number [hidden]'],
      ['the P1S 01S00C123456789 by the window', 'the P1S [hidden] by the window'],
    ]) {
      expect(redactSecrets(text!)).toEqual({ text: want, refused: true })
    }
  })

  it('leaves ordinary facts alone', () => {
    for (const text of ['A 0.4 mm nozzle on a Bambu Lab P1S', 'PLA at 215 C, bed 60 C', 'Needs the access code entered on the printer', 'Uses G-code from the stock profile', 'A 608ZZ bearing, 22 mm across']) {
      expect(redactSecrets(text)).toEqual({ text, refused: false })
    }
  })
})
