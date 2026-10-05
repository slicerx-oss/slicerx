// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ApprovalRequest } from '@slicerx/contracts'
import { AT_HOME, forDisplay, relayBlock } from './verified-card'

const base: ApprovalRequest = {
  id: 'r1',
  sessionId: 's',
  tool: 'sx_start_print',
  permission: 'queue',
  title: 'Totally safe: cleaning the nozzle',
  lines: ['Nothing will be printed'],
  paramsHash: 'x',
  origin: 'mcp',
  actions: [
    { action: 'printer.upload', target: 'bay-2', paramsHash: 'aaaaaaaa11112222' },
    { action: 'printer.start', target: 'bay-2', paramsHash: 'bbbbbbbb33334444' },
  ],
  expiresAt: '2026-10-02T00:05:00Z',
}

it('builds an agent card from the verified actions and drops the agent text', () => {
  const r = forDisplay(base, 'host', { 'bay-2': 'Bay 2' })
  expect(r.title).toBe('Start a print on Bay 2?')
  expect(r.lines.join('\n')).toContain('Request fingerprint bbbbbbbb')
  expect(r.lines.join('\n')).not.toContain('cleaning')
  expect(r.lines.join('\n')).not.toContain('Nothing will be printed')
  // The actions, and so the bed question, are untouched.
  expect(r.actions).toBe(base.actions)
})

it('leaves a phone job and a click on the computer as they are', () => {
  expect(forDisplay({ ...base, origin: 'phone' }, 'pair')).toEqual({ ...base, origin: 'phone' })
  expect(forDisplay({ ...base, origin: 'local_click' }, 'host').title).toBe(base.title)
})

it('says so when a request unlocks nothing it could verify', () => {
  expect(forDisplay({ ...base, actions: [] }, 'pilot').title).toBe('A request needs your answer')
})

describe('over the relay', () => {
  const act = (action: ApprovalRequest['actions'][number]['action']) => ({ ...base, actions: [{ action, target: 'bay-2', paramsHash: 'a' }] })
  it('offers Approve only for pause and stop', () => {
    expect(relayBlock(act('printer.pause'), 'relay')).toBeUndefined()
    expect(relayBlock(act('printer.cancel'), 'relay')).toBeUndefined()
    for (const a of ['printer.start', 'printer.resume', 'printer.gcode', 'printer.config', 'printer.upload'] as const) expect(relayBlock(act(a), 'relay')).toBe(AT_HOME)
    expect(relayBlock({ actions: [] }, 'relay')).toBe(AT_HOME)
  })
  it('changes nothing at home', () => {
    expect(relayBlock(act('printer.start'), 'lan')).toBeUndefined()
  })
})
