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

describe('the Goal commands', () => {
  it('name what each goal gives exactly as the Goal tiles do, from the printer in use', async () => {
    const { set } = await import('../src/state/store')
    const { goalEasy, goalShows } = await import('../src/adapters/config')
    const { goalSubtitle } = await import('../src/lib/estimate-line')
    const { strengthOutcome } = await import('@slicerx/settings/easy')
    const strong = () => builtinCommands(host, []).find((c) => c.id === 'goal-strong')!
    set({ profile: null })
    // SlicerX's own Strong: its walls come from the Strength rule at the goal's strength, the number a slice gets
    const own = strengthOutcome(goalEasy('strong').strength)
    expect(own).toEqual({ walls: 5, infill: 35 })
    expect(strong().title).toBe(`Goal: Strong (${goalSubtitle('strong', goalShows('strong'))})`)
    expect(strong().title).toBe('Goal: Strong (5 walls)')
    // a printer whose own Strong preset prints 6 walls: the tile and the command both say so, read when listed
    const cmd = strong()
    const goalValues = { draft: { layer_height: 0.24 }, standard: { layer_height: 0.2 }, fine: { layer_height: 0.12 }, strong: { layer_height: 0.2, wall_loops: 6 } }
    set({ profile: { goalValues } as never })
    expect(goalSubtitle('strong', goalShows('strong', goalValues))).toBe('6 walls')
    expect(cmd.title).toBe('Goal: Strong (6 walls)')
    expect(builtinCommands(host, []).find((c) => c.id === 'goal-draft')!.title).toBe('Goal: Draft (0.24 mm, fastest)')
    set({ profile: null })
  })

  it('say 5 walls for Strong on a Prusa MK4S, whose maker has no strong preset', async () => {
    const { set } = await import('../src/state/store')
    const { goalShows } = await import('../src/adapters/config')
    const { goalSubtitle } = await import('../src/lib/estimate-line')
    const { stockLayer } = await import('@slicerx/settings')
    // the goal values the app's printer layer carries for the MK4S, as profile sync stores them
    const layer = (await stockLayer({ printerId: 'prusa-mk4s', tier: 'standard', slots: [] }))!
    set({ profile: { goalValues: layer.goalValues } as never })
    // the Goal tile's subtitle (easy-settings.tsx) and the palette row read the same derived values
    expect(goalSubtitle('strong', goalShows('strong', layer.goalValues))).toBe('5 walls')
    expect(builtinCommands(host, []).find((c) => c.id === 'goal-strong')!.title).toBe('Goal: Strong (5 walls)')
    // Standard on the same printer is the maker's 2 walls
    expect(goalSubtitle('standard', goalShows('standard', layer.goalValues))).toBe('0.20 mm')
    expect(layer.goalValues.standard['wall_loops']).toBe(2)
    set({ profile: null })
  })
})
