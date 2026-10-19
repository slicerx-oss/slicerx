// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { checkEditionConfig, defineEditionConfig } from '../src/define.ts'
import { NEUTRAL_EDITION } from '../src/defaults.ts'
import { mergeLayers } from '../src/merge.ts'

const check = (brain: unknown) => checkEditionConfig(mergeLayers(NEUTRAL_EDITION, { ai: { brain } } as never))

describe('ai.brain', () => {
  it('brain defaults when absent', () => {
    const { brain } = defineEditionConfig({}).ai
    expect(brain.cloud.stepUp).toBe('none')
    expect(brain.memory.local).toBe(true)
    expect(brain.memory.sync).toBe('off')
    expect(brain.voice).toBeUndefined()
  })

  it('voice is trimmed and at most 280 characters', () => {
    expect(defineEditionConfig({ ai: { brain: { voice: '  Short and plain.  ' } } }).ai.brain.voice).toBe('Short and plain.')
    expect(check({ voice: 'a'.repeat(280) }).ok).toBe(true)
    const r = check({ voice: 'a'.repeat(281) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain('ai.brain.voice')
  })

  it('stepUp rejects other models', () => {
    expect(check({ cloud: { stepUp: 'sonnet' } }).ok).toBe(true)
    expect(check({ cloud: { stepUp: 'opus' } }).ok).toBe(false)
  })

  it('memory sync is off or opt-in', () => {
    expect(check({ memory: { sync: 'opt-in' } }).ok).toBe(true)
    expect(check({ memory: { sync: 'always' } }).ok).toBe(false)
  })

  it('secret scan covers voice', () => {
    const r = check({ voice: 'Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz when asked' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues).toContainEqual(expect.objectContaining({ path: 'ai.brain.voice', message: expect.stringContaining('secrets do not belong') }))
  })
})
