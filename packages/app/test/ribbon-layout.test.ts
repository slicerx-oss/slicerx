// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model ribbon's layout: every shelf tool has a place and a shaded icon drawn at all three sizes, the tabs and
// groups are ribbon A's, and an edition without the modeling tools drops the Sketch tab and the modeling items.
import { TOOL_ICONS } from '@slicerx/ui/tool-icons'
import { describe, expect, it } from 'vitest'
import { RIBBON, ribbonGroups, ribbonTabs } from '../src/workspaces/design/ribbon-layout'
import { availableTools, SHELF_TOOLS } from '../src/workspaces/design/shelf-tools'

const all = availableTools({ modeling: true, drawing: true })
const placed = (modeling: boolean, tools = all) => new Set((['solid', 'mesh', 'sketch'] as const).flatMap((t) => ribbonGroups(t, tools, modeling).flatMap((g) => g.items.map((i) => `${i.kind}:${i.id}`))))

describe('the ribbon layout', () => {
  it('has ribbon A tabs and Solid groups', () => {
    expect(ribbonTabs(true).map((t) => t.label)).toEqual(['Solid', 'Mesh', 'Sketch'])
    expect(RIBBON.solid.map((g) => g.label)).toEqual(['Create', 'Modify', 'Inspect', 'Output'])
  })

  it('places every shelf tool that has a shelf place, and Auto orient in Mesh', () => {
    const where = placed(true)
    for (const t of SHELF_TOOLS) expect(where.has(t.shelf?.menu ? `menu:${t.shelf.menu}` : `tool:${t.id}`), t.id).toBe(true)
    expect(ribbonGroups('mesh', all, true).flatMap((g) => g.items.map((i) => i.id))).toContain('orient')
  })

  it('draws every icon it uses at 32, 24 and 16 px', () => {
    const icons = new Set<string>(SHELF_TOOLS.map((t) => t.toolIcon))
    for (const tab of Object.values(RIBBON)) for (const g of tab) for (const i of g.items) if (i.kind !== 'tool') icons.add(i.icon)
    for (const name of icons) {
      const drawn = (TOOL_ICONS as Record<string, Record<number, string>>)[name]
      expect(drawn, name).toBeDefined()
      for (const s of [32, 24, 16]) expect(drawn?.[s]?.length, `${name} ${s}`).toBeGreaterThan(20)
    }
  })

  it('without the modeling tools, no Sketch tab and no modeling items', () => {
    expect(ribbonTabs(false).map((t) => t.id)).toEqual(['solid', 'mesh'])
    const where = placed(false, availableTools({ modeling: false, drawing: true }))
    for (const id of ['sketch', 'push', 'fillet', 'thread']) expect(where.has(`tool:${id}`), id).toBe(false)
    for (const id of ['extrude', 'revolve', 'chamfer']) expect(where.has(`action:${id}`), id).toBe(false)
    expect(where.has('menu:face')).toBe(false)
    for (const id of ['cut', 'measure', 'array', 'repair']) expect(where.has(`tool:${id}`), id).toBe(true)
    expect(where.has('action:merge')).toBe(true)
  })
})
