// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Each shelf tool has one command bar entry, gated the way the shelf gates it: by the edition's modeling tools, the
// drawing tools switch and the selection.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NEUTRAL, setCurrentEdition } from '../src/edition'
import { plateCommands } from '../src/plate/commands'
import { set } from '../src/state/store'
import { SHELF_TOOLS } from '../src/workspaces/design/shelf-tools'

const commands = () => plateCommands(() => ({ id: 'slicerx' }), undefined)
const command = (id: string) => commands().find((c) => c.id === id)
const on = (id: string) => command(id)?.enabled?.() ?? true

beforeEach(() => set({ selection: null, selectedIds: [], cadTools: true }))
afterEach(() => setCurrentEdition(NEUTRAL))

describe('shelf tool commands', () => {
  it('gives every tool its own command', () => {
    const ids = SHELF_TOOLS.map((t) => t.command)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(command(id), id).toBeDefined()
  })

  it('waits for a selection only where the tool does', () => {
    for (const t of SHELF_TOOLS) expect(on(t.command), t.id).toBe(!t.needsSelection)
    set({ selection: 'a', selectedIds: ['a'] })
    for (const t of SHELF_TOOLS) expect(on(t.command), t.id).toBe(true)
  })

  it('turns the drawing tools off with the drawing switch', () => {
    set({ selection: 'a', selectedIds: ['a'], cadTools: false })
    for (const t of SHELF_TOOLS) expect(on(t.command), t.id).toBe(!t.drawing)
  })

  it('leaves out every modeling tool in an edition without them', () => {
    setCurrentEdition({ ...NEUTRAL, features: { ...NEUTRAL.features, cad: false } })
    const left = new Set(commands().map((c) => c.id))
    for (const t of SHELF_TOOLS) expect(left.has(t.command), t.id).toBe(!t.modeling)
  })
})
