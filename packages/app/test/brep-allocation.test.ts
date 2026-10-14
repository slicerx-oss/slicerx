// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment node
import { expect, it } from 'vitest'
import type { SxBrepModule } from '../../brep/lib/sx_brep.mjs'
import { brepModule } from '../src/geom/brep'

function tracked(fault = '') {
  const live = new Map<number, 'request' | 'reply'>()
  let allocated = 0
  const alloc = (kind: 'request' | 'reply') => { const p = ++allocated; live.set(p, kind); return p }
  const release = (p: number, kind: 'request' | 'reply') => { expect(live.get(p)).toBe(kind); live.delete(p) }
  const m: SxBrepModule & { HEAPU8: Uint8Array } = {
    HEAPU8: new Uint8Array(0),
    stringToNewUTF8: () => {
      const n = allocated + 1
      if (fault === `throw allocation ${n}`) throw new Error(fault)
      if (fault === `null allocation ${n}`) return 0
      return alloc('request')
    },
    _sx_brep_call: () => {
      if (fault === 'call') throw new Error(fault)
      if (fault === 'null reply') return 0
      return alloc('reply')
    },
    UTF8ToString: () => {
      if (fault === 'decode') throw new Error(fault)
      return fault === 'parse' ? '{' : fault === 'kernel error' ? '{"error":"bad body"}' : '{"bodies":0}'
    },
    _sx_brep_free: (p) => release(p, 'reply'),
    _free: (p) => release(p, 'request'),
  }
  return { api: brepModule(m), live, allocated: () => allocated }
}

it('serializes before allocating either request string', () => {
  const cycle: Record<string, unknown> = {}
  cycle['self'] = cycle
  for (const request of [cycle, { value: 1n }, { toJSON() { throw new Error('serialize') } }, { toJSON() { return undefined } }]) {
    const t = tracked()
    expect(() => t.api.call('box', request)).toThrow()
    expect(t.allocated()).toBe(0)
    expect(t.live.size).toBe(0)
  }
})

it.each(['throw allocation 1', 'throw allocation 2', 'null allocation 1', 'null allocation 2', 'call', 'null reply', 'decode', 'parse', 'kernel error'])('frees every owned allocation after %s', (fault) => {
  const t = tracked(fault)
  expect(() => t.api.call('box', {})).toThrow()
  expect(t.live.size).toBe(0)
})

it('frees requests and reply after successful repeated calls', () => {
  const t = tracked()
  for (let i = 0; i < 10; i++) expect(t.api.call('count', undefined)).toEqual({ bodies: 0 })
  expect(t.allocated()).toBe(30)
  expect(t.live.size).toBe(0)
})
