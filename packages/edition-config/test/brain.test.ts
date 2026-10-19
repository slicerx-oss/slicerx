// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkEditionConfig, defineEditionConfig } from '../src/define.ts'
import { NEUTRAL_EDITION } from '../src/defaults.ts'
import { mergeLayers } from '../src/merge.ts'
import { editionKnowledgeFiles } from '../src/node.ts'

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

  it('knowledge paths must stay inside the edition folder', () => {
    expect(check({ knowledge: ['knowledge', 'guides/dock.yaml', './more'] }).ok).toBe(true)
    for (const path of ['../other', 'guides/../../other', '/etc/kb', 'C:/kb', 'C:\\kb', '\\\\server\\kb', 'guides\\..\\..\\x', '~/kb']) {
      const r = check({ knowledge: [path] })
      expect(r.ok, path).toBe(false)
      if (!r.ok) expect(r.issues.map((i) => i.path)).toContain('ai.brain.knowledge.0')
    }

    // on disk: a folder that links outside the edition is refused, and so is a missing one
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sx-brain-')))
    const edition = join(dir, 'harbor')
    mkdirSync(join(edition, 'own', 'deep'), { recursive: true })
    mkdirSync(join(dir, 'outside'))
    writeFileSync(join(edition, 'own', 'dock.yaml'), 'kind: guide\n')
    writeFileSync(join(edition, 'own', 'deep', 'bracket.yml'), 'kind: guide\n')
    writeFileSync(join(edition, 'own', 'notes.txt'), 'not knowledge\n')
    writeFileSync(join(dir, 'outside', 'other.yaml'), 'kind: guide\n')
    symlinkSync(join(dir, 'outside'), join(edition, 'linked'))
    const configFile = join(edition, 'edition.config.json')
    const files = (knowledge: string[]) => editionKnowledgeFiles(defineEditionConfig({ ai: { brain: { knowledge } } }), configFile)
    expect(files(['own'])).toEqual([join(edition, 'own', 'deep', 'bracket.yml'), join(edition, 'own', 'dock.yaml')])
    expect(files([])).toEqual([])
    expect(() => files(['linked'])).toThrow(/outside the edition folder/)
    symlinkSync(join(dir, 'outside', 'other.yaml'), join(edition, 'own', 'other.yaml'))
    expect(() => files(['own'])).toThrow(/outside the edition folder/)
    expect(() => files(['missing'])).toThrow(/not found/)
  })

  it('groups cannot add tools', () => {
    expect(check({ tools: { printers: false, web: false, design: true } }).ok).toBe(true)
    const r = check({ tools: { cad: true } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain('ai.brain.tools')
    expect(check({ tools: { printers: 'off' } }).ok).toBe(false)
    expect(defineEditionConfig({}).ai.brain.tools).toBeUndefined()
  })

  it('routing names an own-key provider and its models', () => {
    expect(check({ routing: { provider: 'openai', base: 'gpt-6-luna', step: 'gpt-6-sol' } }).ok).toBe(true)
    expect(check({ routing: { provider: 'mimir-cloud' } }).ok).toBe(false)
    expect(check({ routing: { base: '' } }).ok).toBe(false)
    expect(check({ routing: { model: 'gpt-6-sol' } }).ok).toBe(false)
  })
})
