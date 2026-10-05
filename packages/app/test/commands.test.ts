// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { CommandSpec, Host } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { builtinCommands } from '../src/commands/builtin'
import { fuzzyScore } from '../src/commands/fuzzy'
import { commandIdForTool, commandTools, registerCommands, runCommand, searchCommands } from '../src/commands/registry'

const host = {} as Host
const workspaces = ['prepare', 'preview', 'feed', 'library', 'printers', 'pilot'].map((id) => ({ id, label: id }))

describe('fuzzy matching', () => {
  it('matches subsequences and rejects the rest', () => {
    expect(fuzzyScore('slc', 'Slice the plate')).toBeGreaterThan(0)
    expect(fuzzyScore('xyz', 'Slice the plate')).toBe(-1)
  })

  it('ranks a contiguous word-start hit above a scattered one', () => {
    expect(fuzzyScore('plate', 'Slice the plate')).toBeGreaterThan(fuzzyScore('plate', 'Pause the latest'))
  })

  it('is case insensitive', () => {
    expect(fuzzyScore('EXPORT', 'Export G-code')).toBeGreaterThan(0)
  })
})

describe('command registry', () => {
  it('has at least 30 built-in commands with unique ids', () => {
    const specs = builtinCommands(host, workspaces)
    expect(specs.length).toBeGreaterThanOrEqual(30)
    expect(new Set(specs.map((c) => c.id)).size).toBe(specs.length)
  })

  it('finds commands by keyword and title', () => {
    const off = registerCommands(builtinCommands(host, workspaces))
    expect(searchCommands('go printers')[0]?.command.id).toBe('open-printers')
    expect(searchCommands('export gcode').some((m) => m.command.id === 'export-gcode')).toBe(false)
    expect(searchCommands('tree').some((m) => m.command.id === 'supports-auto')).toBe(true)
    off()
  })

  it('refuses a disabled command and reports an unknown one', async () => {
    const off = registerCommands([{ id: 't-off', title: 'Off', section: 'help', enabled: () => false, run: () => undefined }])
    expect(await runCommand('t-off')).toMatchObject({ ok: false, reason: 'disabled' })
    expect(await runCommand('nope')).toMatchObject({ ok: false, reason: 'unknown' })
    off()
  })

  it('exposes only tool commands to Pilot and maps names back', () => {
    const off = registerCommands([
      { id: 'goal-fine', title: 'Fine', section: 'settings', tool: { permission: 'slice' }, run: () => undefined },
      { id: 'no-tool', title: 'Hidden', section: 'help', run: () => undefined },
    ])
    const tools = commandTools()
    expect(tools.map((t) => t.name)).toContain('app.goal_fine')
    expect(tools.map((t) => t.name)).not.toContain('app.no_tool')
    expect(commandIdForTool('app.goal_fine')).toBe('goal-fine')
    off()
  })

  it('filters 500 commands well under a frame per keystroke', () => {
    const many: CommandSpec[] = Array.from({ length: 500 }, (_, i) => ({ id: `c${i}`, title: `Command number ${i} for plate ${i % 7}`, section: 'plate', keywords: ['alpha', 'beta'], run: () => undefined }))
    const off = registerCommands(many)
    const t0 = performance.now()
    for (const q of ['c', 'co', 'com', 'comm', 'number 4', 'plate 3']) searchCommands(q)
    const perKeystroke = (performance.now() - t0) / 6
    off()
    expect(perKeystroke).toBeLessThan(16)
  })
})
