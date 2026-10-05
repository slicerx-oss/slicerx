// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it } from 'vitest'
import type { CommandSpec, MeshHandle } from '@slicerx/contracts'
import { scoreCommand } from '../src/commands/fuzzy'
import { askContext, askPrompt, modeFor, navEntries, questionText, rankCommands, readsAsQuestion, settingEntries, suggestions } from '../src/commands/hub'
import { builtinCommands } from '../src/commands/builtin'
import { plateCommands } from '../src/plate/commands'
import { get, set, type PlateEntry } from '../src/state/store'
import * as api from '../src/adapters/settings'
import { baseConfig } from '../src/adapters/settings'

const cmd = (id: string, title: string, keywords: string[] = [], workspace?: CommandSpec['workspace']): CommandSpec => ({ id, title, section: 'plate', keywords, ...(workspace ? { workspace } : {}), run: () => undefined })
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [] })
const entry = (id: string, name = id): PlateEntry => ({ id, name, handle: handle(id), parts: [], colors: [], transform: [] })

beforeEach(() => set({ plate: [], selection: null, selectedIds: [], printerSlots: [], slice: { status: 'idle' } }))

describe('ranking', () => {
  const list = [cmd('copy', 'Copy the selected objects', ['clipboard']), cmd('paste', 'Paste', ['clipboard']), cmd('duplicate', 'Duplicate the selected objects', ['clone', 'copy']), cmd('tool-paint', 'Paint tool: color, seam and support', ['brush', 'mmu']), cmd('slice', 'Slice the plate', ['start'], 'preview')]
  const score = (q: string, c: CommandSpec) => scoreCommand(q, c.title, c.keywords)

  it('finds a command by its title, an alias, or a part of either', () => {
    expect(rankCommands('paste', list, 'prepare', score)[0]!.command.id).toBe('paste')
    expect(rankCommands('clone', list, 'prepare', score)[0]!.command.id).toBe('duplicate')
    expect(rankCommands('brush', list, 'prepare', score)[0]!.command.id).toBe('tool-paint')
    expect(rankCommands('mmu', list, 'prepare', score).map((r) => r.command.id)).toContain('tool-paint')
  })

  it('puts commands of the workspace in front on a close call, and skips disabled ones', () => {
    const r = rankCommands('the', [cmd('a', 'Open the thing', [], 'preview'), cmd('b', 'Open the thing', [], 'prepare')], 'prepare', score)
    expect(r.map((x) => x.command.id)).toEqual(['b', 'a'])
    const off: CommandSpec = { ...cmd('off', 'Paste it'), enabled: () => false }
    expect(rankCommands('paste', [off, ...list], 'prepare', score).map((x) => x.command.id)).not.toContain('off')
  })

  it('every new action is registered with aliases that find it', () => {
    // Availability depends on the selection and clipboard; this checks what the bar can find.
    const all = [...plateCommands(() => ({ id: 'slicerx' }), undefined), ...builtinCommands({ slicer: {} } as never, [])].map((c) => ({ ...c, enabled: () => true }))
    const find = (q: string) => rankCommands(q, all, 'prepare', score).map((r) => r.command.id)
    expect(find('copy')).toContain('copy')
    expect(find('paste')).toContain('paste')
    expect(find('duplicate')).toContain('duplicate')
    expect(find('clone')).toContain('duplicate')
    expect(find('paint')).toContain('tool-paint')
    expect(find('modifier')).toContain('volume-modifier')
    expect(find('support blocker')).toContain('volume-blocker')
    expect(find('orient')).toContain('object-orient')
    expect(find('repair')).toContain('object-repair')
    expect(find('hollow')).toContain('object-hollow')
    expect(find('emboss')).toContain('object-text')
    expect(find('fill bed')).toContain('fill-bed')
    expect(find('calibration')).toContain('calibration')
    expect(find('printer settings')).toContain('printer-settings')
    expect(find('shortcuts')).toContain('controls-open')
  })
})

describe('questions for mimir', () => {
  it('reads questions and requests, not command names', () => {
    for (const q of ['how do I stop stringing', 'Why is my first layer rough?', '?anything', 'what infill for a hook', 'please orient this for strength', 'printing a long thin bracket in petg without warping']) expect(readsAsQuestion(q), q).toBe(true)
    for (const q of ['paste', 'slice', 'printer settings', 'arrange all', '']) expect(readsAsQuestion(q), q).toBe(false)
  })

  it('strips the question mark prefix', () => {
    expect(questionText('?  how to dry petg')).toBe('how to dry petg')
    expect(questionText('how?')).toBe('how?')
  })

  it('sends the selection and plate as context', () => {
    set({ plate: [entry('a', 'Hook'), entry('b', 'Clip')], selection: 'a', selectedIds: ['a'], printerSlots: [{ id: 'A1', material: 'PETG' }] })
    const ctx = askContext(get(), 'Bay 1')
    expect(ctx).toContain('2 objects')
    expect(ctx).toContain('Selected: Hook (20 x 20 x 20 mm)')
    expect(ctx).toContain('Printer: Bay 1')
    expect(ctx).toContain('Loaded filament: PETG')
    const prompt = askPrompt('? how strong is this', ctx)
    expect(prompt.startsWith('how strong is this\n\nContext from the app:\n')).toBe(true)
    expect(prompt).not.toMatch(/key|token|secret/i)
  })
})

describe('jump targets', () => {
  const inputs = {
    plates: [{ id: 'p1', name: 'Plate 1', count: 2 }, { id: 'p2', name: 'Gold plate', count: 0 }],
    activePlate: 'p1',
    objects: [{ id: 'a', name: 'Cable clip' }, { id: 'b', name: 'Bracket' }],
    printers: [{ id: 'bay-1', name: 'Bay 1', model: 'X1 Carbon' }],
    presets: [{ id: 'up1', name: 'Silk PLA', kind: 'filament' }],
  }
  const calls: string[] = []
  const act = { plate: (id: string) => calls.push(`plate ${id}`), object: (id: string) => calls.push(`object ${id}`), printer: (id: string) => calls.push(`printer ${id}`), preset: (id: string) => calls.push(`preset ${id}`) }

  it('matches plates (not the current one), objects, printers and presets by name', () => {
    expect(navEntries('gold', inputs, act).map((e) => e.id)).toEqual(['plate:p2'])
    expect(navEntries('plate 1', inputs, act).map((e) => e.id)).not.toContain('plate:p1')
    expect(navEntries('cable', inputs, act)[0]!.id).toBe('obj:a')
    expect(navEntries('x1', inputs, act)[0]!.id).toBe('printer:bay-1')
    expect(navEntries('silk', inputs, act)[0]!.id).toBe('preset:up1')
    navEntries('silk', inputs, act)[0]!.run()
    navEntries('bracket', inputs, act)[0]!.run()
    expect(calls).toEqual(['preset up1', 'object b'])
  })

  it('finds a setting by its name or its current value and names the mode it needs', () => {
    const opened: string[] = []
    const s = { easy: get().easy, overrides: { wall_loops: 7 }, settingsMode: 'simple' as const }
    const byName = settingEntries('wall loops', s, (d, m) => opened.push(`${d.key}:${m}`), api)
    expect(byName[0]!.id).toBe('setting:wall_loops')
    expect(byName[0]!.hint).toContain('7')
    byName[0]!.run()
    expect(opened[0]).toMatch(/^wall_loops:(simple|advanced|expert|developer)$/)
    expect(settingEntries('x', s, () => undefined, api)).toEqual([])
    // A printer setting is named as one.
    expect(settingEntries('retraction length', s, () => undefined, api).some((e) => e.hint.startsWith('Printer setting'))).toBe(true)
    void baseConfig
  })

  it('raises the mode only when the setting needs more than the current one', () => {
    expect(modeFor({ mode: 'expert' }, 'simple')).toBe('expert')
    expect(modeFor({ mode: 'advanced' }, 'expert')).toBe('expert')
    expect(modeFor({ mode: 'develop' }, 'advanced')).toBe('developer')
    expect(modeFor({ mode: 'simple' }, 'advanced')).toBe('advanced')
  })
})

describe('suggestions', () => {
  const all = new Set(['plate-open', 'plate-default', 'copy', 'duplicate', 'object-orient', 'tool-paint', 'volume-modifier', 'arrange-all', 'select-all', 'slice', 'export-gcode', 'preview-all-layers', 'bridge-open', 'pilot-ask'])
  const base = { plate: [], plates: [], slice: { status: 'idle' as const }, selection: null, workspace: 'prepare' as const, bridgeStatus: { state: 'off' as const }, pilot: null }

  it('starts with opening a model on an empty plate', () => {
    expect(suggestions(base, all).slice(0, 2)).toEqual(['plate-open', 'plate-default'])
  })

  it('offers object actions with a selection and slicing when the slice is missing or stale', () => {
    const withSel = suggestions({ ...base, plate: [entry('a')], selection: 'a' }, all)
    expect(withSel).toContain('copy')
    expect(withSel).toContain('slice')
    const sliced = suggestions({ ...base, plate: [entry('a')], selection: 'a', slice: { status: 'done', result: {} as never, stale: false } }, all)
    expect(sliced).not.toContain('slice')
  })

  it('leaves out mimir when it is off and commands that are not there', () => {
    expect(suggestions({ ...base, pilot: { mode: 'off' } }, all)).not.toContain('pilot-ask')
    expect(suggestions({ ...base }, new Set(['slice']))).toEqual([])
  })
})
