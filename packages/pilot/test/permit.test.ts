// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApprovalRequest } from '@slicerx/contracts'
import { canonicalJson, hashParams } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { decide, normalizePolicy } from '../src/gate'
import { createApprovalBroker } from '../src/permit/broker'

const fixtures = join(import.meta.dirname, '..', '..', 'contracts', 'fixtures')

async function request(id: string, actions: { action: ApprovalRequest['actions'][number]['action']; target: string; params: unknown }[], expiresAt = '2099-09-30T14:05:00.000Z'): Promise<ApprovalRequest> {
  return {
    id,
    sessionId: 's1',
    tool: 'printer.queue',
    permission: 'queue',
    title: 'Send plate 1?',
    lines: [],
    paramsHash: await hashParams({ plate: 1 }),
    actions: await Promise.all(actions.map(async (a) => ({ action: a.action, target: a.target, paramsHash: await hashParams(a.params) }))),
    expiresAt,
  }
}

describe('canonical JSON', () => {
  it('matches the Rust test vectors written by sx-permit', async () => {
    const file = JSON.parse(readFileSync(join(fixtures, 'pilot-canonical-json.json'), 'utf8')) as { vectors: { input: unknown; canonical: string; sha256: string }[] }
    expect(file.vectors.length).toBeGreaterThan(3)
    for (const v of file.vectors) {
      expect(canonicalJson(v.input)).toBe(v.canonical)
      expect(await hashParams(v.input)).toBe(v.sha256)
    }
  })

  it('sorts keys at every level and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[1,{"y":2,"z":1}]},"b":1}')
  })

  it('parses the approval request fixture as the TS type', () => {
    const req = JSON.parse(readFileSync(join(fixtures, 'pilot-approval-request.json'), 'utf8')) as ApprovalRequest
    expect(req.actions.length).toBeGreaterThan(0)
    expect(req.actions.every((a) => /^[0-9a-f]{64}$/.test(a.paramsHash))).toBe(true)
  })
})

describe('approval broker', () => {
  const params = { printerId: 'bay-2', name: 'plate_1.gcode', opts: {} }

  it('grants a single-use token bound to action, target and params', async () => {
    let now = 1_000_000
    const b = createApprovalBroker({ now: () => now })
    await b.register(await request('r1', [{ action: 'printer.start', target: 'bay-2', params }]))
    const token = await b.grant('r1')
    const h = await hashParams(params)
    expect(await b.verify(token, 'printer.start', 'bay-3', h)).toEqual({ ok: false, reason: 'mismatch' })
    expect(await b.verify(token, 'printer.start', 'bay-2', await hashParams({ ...params, name: 'other.gcode' }))).toEqual({ ok: false, reason: 'mismatch' })
    expect(await b.verify(token, 'printer.upload', 'bay-2', h)).toEqual({ ok: false, reason: 'mismatch' })
    expect(await b.verify(token, 'printer.start', 'bay-2', h)).toEqual({ ok: true })
    expect(await b.verify(token, 'printer.start', 'bay-2', h)).toEqual({ ok: false, reason: 'used' })
    now += 1
  })

  it('refuses to grant a card after its own expiry, like sx-permit', async () => {
    let now = Date.parse('2026-09-30T14:00:00.000Z')
    const b = createApprovalBroker({ now: () => now })
    await b.register(await request('late', [{ action: 'printer.pause', target: 'bay-1', params: { printerId: 'bay-1' } }], '2026-09-30T14:05:00.000Z'))
    await b.register(await request('bad-date', [{ action: 'printer.pause', target: 'bay-1', params: { printerId: 'bay-1' } }], 'not a date'))
    await b.register(await request('on-time', [{ action: 'printer.pause', target: 'bay-1', params: { printerId: 'bay-1' } }], '2026-09-30T14:05:00.000Z'))
    await expect(b.grant('bad-date')).rejects.toThrow(/expired/)
    await b.grant('on-time')
    now = Date.parse('2026-09-30T14:05:00.000Z')
    await expect(b.grant('late')).rejects.toThrow(/expired/)
    // Denied for good: a later grant fails too, and it is no longer pending.
    await expect(b.grant('late')).rejects.toThrow(/already denied/)
    expect(b.pending()).toEqual([])
  })

  it('rejects expired, tampered, denied and unknown tokens', async () => {
    let now = 0
    const b = createApprovalBroker({ now: () => now, ttlMs: 1000 })
    const h = await hashParams(params)
    await b.register(await request('r1', [{ action: 'printer.start', target: 'bay-2', params }]))
    await b.register(await request('r2', [{ action: 'printer.start', target: 'bay-2', params }]))
    const t1 = await b.grant('r1')
    expect(await b.verify({ ...t1, token: `${t1.token.slice(0, -2)}xx` }, 'printer.start', 'bay-2', h)).toEqual({ ok: false, reason: 'bad_signature' })
    expect(await b.verify({ ...t1, requestId: 'r2' }, 'printer.start', 'bay-2', h)).toEqual({ ok: false, reason: 'unknown' })
    now = 1000
    expect(await b.verify(t1, 'printer.start', 'bay-2', h)).toEqual({ ok: false, reason: 'expired' })
    await b.deny('r2')
    await expect(b.grant('r2')).rejects.toThrow()
    expect(await b.verify({ requestId: 'nope', token: 'x', expiresAt: '' }, 'printer.start', 'bay-2', h)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('cannot be granted twice and keeps its own copy of the request', async () => {
    const b = createApprovalBroker()
    const req = await request('r1', [{ action: 'printer.start', target: 'bay-2', params }])
    await b.register(req)
    // Widening the caller's object after registering must not widen the grant.
    req.actions.push({ action: 'printer.start', target: 'bay-1', paramsHash: await hashParams({ printerId: 'bay-1', name: 'x', opts: {} }) })
    const t = await b.grant('r1')
    await expect(b.grant('r1')).rejects.toThrow()
    expect(await b.verify(t, 'printer.start', 'bay-1', await hashParams({ printerId: 'bay-1', name: 'x', opts: {} }))).toEqual({ ok: false, reason: 'mismatch' })
  })

  it('refuses malformed action lists', async () => {
    const b = createApprovalBroker()
    const req = await request('r1', [{ action: 'printer.start', target: 'bay-2', params }])
    const first = req.actions[0]
    if (first) first.paramsHash = 'not-a-hash'
    await expect(b.register(req)).rejects.toThrow()
  })
})

describe('permission gate', () => {
  it('always allows read and applies class modes', () => {
    const p = normalizePolicy({ classes: { slice: 'allow', queue: 'ask', start: 'ask', profile: 'off' } })
    expect(decide(p, 'read')).toBe('allow')
    expect(decide(p, 'slice')).toBe('allow')
    expect(decide(p, 'queue')).toBe('ask')
    expect(decide(p, 'profile')).toBe('off')
  })

  it('never lets start be allowed at class level', () => {
    const p = normalizePolicy({ classes: { start: 'allow' } })
    expect(p.classes.start).toBe('ask')
    expect(decide({ classes: { ...p.classes, start: 'allow' } }, 'start')).toBe('ask')
  })

  it('honors per-printer start allow, but not over a class set to off', () => {
    const p = normalizePolicy({ classes: { start: 'ask', queue: 'off' }, printers: { 'bay-2': { start: 'allow', queue: 'allow' } } })
    expect(decide(p, 'start', 'bay-2')).toBe('allow')
    expect(decide(p, 'start', 'bay-3')).toBe('ask')
    expect(decide(p, 'queue', 'bay-2')).toBe('off')
  })

  it('falls back to defaults for garbage', () => {
    expect(normalizePolicy('nope').classes.start).toBe('ask')
    expect(Object.keys(normalizePolicy('nope').classes)).not.toContain('buy')
    expect(normalizePolicy({ classes: { queue: 'yolo' } }).classes.queue).toBe('ask')
  })
})
