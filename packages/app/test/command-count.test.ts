// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { CommandSpec } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { registerCommands } from '../src/commands/registry'
import { ASK, shownCommands } from '../src/shell/command-bar'

const cmd = (id: string): CommandSpec => ({ id, title: id, section: 'plate', run: () => undefined })

describe('command bar footer', () => {
  it('counts the command rows only, not the settings, places or the assistant row', () => {
    registerCommands([cmd('export-stl'), cmd('export-obj'), cmd(ASK)])
    const groups = [
      { title: '2 commands', items: [{ id: 'export-stl', label: 'Export the plate as STL' }, { id: 'export-obj', label: 'Export the plate as OBJ' }] },
      { title: 'Go to', items: [{ id: 'plate:plate-1', label: 'Plate 1' }] },
      { title: 'Settings', items: [{ id: 'setting:top_surface_expansion_direction', label: 'Top surface expansion direction' }] },
      { title: 'mimir', items: [{ id: ASK, label: 'Ask mimir: export' }] },
    ]
    expect(shownCommands(groups)).toBe(2)
  })
})
