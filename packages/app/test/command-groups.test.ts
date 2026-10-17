// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the command bar lists for a typed line (moved from plate.spec.ts): a question ends with the mimir row, a setting
// by name opens Expert settings at that setting, and with mimir off the row is never offered. The ranking, the
// question test and the setting index have their own cases in hub.test.ts.
import type { CommandSpec } from '@slicerx/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerCommands } from '../src/commands/registry'
import * as api from '../src/adapters/settings'
import { commandGroups } from '../src/shell/command-results'
import { ASK } from '../src/shell/command-bar-id'
import { get, set } from '../src/state/store'

const cmd = (id: string, title: string, keywords: string[] = []): CommandSpec => ({ id, title, section: 'plate', keywords, run: () => undefined })
let off: () => void = () => {}

beforeEach(() => {
  off = registerCommands([cmd('test.clone', 'Duplicate the selected objects', ['clone']), cmd(ASK, 'Ask mimir')])
  set({ commandOpen: true, expertOpen: false, settingFocus: null })
})
afterEach(() => off())

function groups(query: string, over: { pilot?: boolean; pilotMode?: 'on' | 'connect' | 'off' } = {}) {
  const s = get()
  const actions = new Map<string, () => void>()
  const out = commandGroups({
    open: true,
    all: [cmd('test.clone', 'Duplicate the selected objects', ['clone'])],
    query,
    workspace: 'prepare',
    spaces: [],
    pilot: over.pilot ?? true,
    pilotMode: over.pilotMode ?? 'on',
    toolHint: null,
    fleet: { data: [] },
    actions,
    pilotLabel: 'mimir',
    settingsApi: api,
    recents: [],
    plate: [],
    plates: s.plates,
    activePlate: s.activePlate,
    userPresets: [],
    settingsMode: 'advanced',
    easy: s.easy,
    overrides: {},
  })
  return { out, actions }
}

describe('the command bar results', () => {
  it('finds a command by its alias', () => {
    const { out } = groups('clone')
    expect(out[0]!.items.map((i) => i.label)).toContain('Duplicate the selected objects')
  })

  it('ends with the mimir row for a line that reads as a question', () => {
    const { out } = groups('how do I stop stringing?')
    const last = out[out.length - 1]!.items.at(-1)!
    expect(last.id).toBe(ASK)
    expect(last.label).toContain('Ask mimir')
  })

  it('a setting by name opens Expert settings at that setting', () => {
    const { out, actions } = groups('wall loops')
    const row = out.find((g) => g.title === 'Settings')!.items[0]!
    expect(row.hint).toContain('now')
    actions.get(row.id)!()
    expect(get().expertOpen).toBe(true)
    expect(get().settingFocus?.label).toMatch(/wall/i)
  })

  it('with mimir off the bar does not offer it, for a question or a "?" line', () => {
    expect(groups('how do I stop stringing?', { pilot: false, pilotMode: 'off' }).out.flatMap((g) => g.items).some((i) => i.id === ASK)).toBe(false)
    expect(groups('clone', { pilot: false, pilotMode: 'off' }).out[0]!.items.map((i) => i.label)).toContain('Duplicate the selected objects')
    expect(groups('? why', { pilot: false, pilotMode: 'off' }).out.flatMap((g) => g.items)).toEqual([])
  })
})
