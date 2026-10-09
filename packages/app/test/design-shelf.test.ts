// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's shelf and Slice's Tools menu read one list. The shelf groups it as Create, Shape, Fasten and Mesh, with
// Measure and Values at the end, and offers the tools for the pick in its next slot; the menu keeps its order. A modeling tool opens Design from anywhere; Cut, Measure, Array and the mesh tools do not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NEUTRAL, setCurrentEdition } from '../src/edition'
import { setGeomProvider, type GeomProvider } from '../src/geom/client'
import { fullEngine, resetFullEngine, warmFullEngine } from '../src/geom/full-engine'
import { engineModules } from '../src/geom/modules'
import { get, set } from '../src/state/store'
import { openTool } from '../src/workspaces/design/open-tool'
import { availableTools, nextTools, opensDesign, SHELF_GROUPS, shelfGroup, SHELF_TOOLS } from '../src/workspaces/design/shelf-tools'

const NO_CAD = { ...NEUTRAL, features: { ...NEUTRAL.features, cad: false } }
const names = (group: (typeof SHELF_GROUPS)[number]['id'], modeling = true, drawing = true) =>
  shelfGroup(availableTools({ modeling, drawing }), group).map((e) => (e.kind === 'tool' ? e.tool.short ?? e.tool.label : `${e.menu}: ${e.tools.map((t) => t.label).join(', ')}`))

beforeEach(() => set({ workspace: 'preview', modelMode: 'slice', objectTool: null }))
afterEach(() => {
  setCurrentEdition(NEUTRAL)
  setGeomProvider(null)
  resetFullEngine()
})

describe('the shelf', () => {
  it('groups the tools as the plan does', () => {
    expect(SHELF_GROUPS.map((g) => g.id)).toEqual(['create', 'shape', 'fasten', 'mesh', 'utility'])
    expect(names('create')).toEqual(['Sketch', 'face: SVG on a face, Shape on a face, Text on a face'])
    expect(names('shape')).toEqual(['Push and pull', 'Fillet', 'Shell', 'Subtract', 'Cut', 'Array'])
    expect(names('fasten')).toEqual(['Hole', 'Thread'])
    expect(names('mesh')).toEqual(['mesh: Hollow, Repair mesh, Simplify mesh'])
    expect(names('utility')).toEqual(['Measure', 'Values'])
  })

  it('leaves out the modeling tools in an edition without them, and the drawing tools when Settings turns them off', () => {
    expect(names('create', false)).toEqual([])
    expect(names('fasten', false)).toEqual([])
    expect(names('shape', true, false)).toEqual(['Push and pull', 'Fillet', 'Shell', 'Cut', 'Array'])
  })

  it('offers up to three tools for the pick in the next slot, and none for no pick', () => {
    const tools = availableTools({ modeling: true, drawing: true })
    const ids = (pick: Parameters<typeof nextTools>[1]) => nextTools(tools, pick).map((t) => t.id)
    expect(ids('face')).toEqual(['push', 'sketch', 'shell'])
    expect(ids('round')).toEqual(['holefit', 'thread'])
    expect(ids('edge')).toEqual(['fillet'])
    expect(ids('object')).toEqual(['cut', 'array', 'holefit'])
    expect(ids(null)).toEqual([])
    // Without the modeling tools an object still gets Cut and Array.
    expect(nextTools(availableTools({ modeling: false, drawing: true }), 'object').map((t) => t.id)).toEqual(['cut', 'array'])
  })

  it('gives every tool its own icon', () => {
    const icons = SHELF_TOOLS.map((t) => t.icon)
    expect(new Set(icons).size).toBe(icons.length)
  })
})

describe('the Tools menu in Slice', () => {
  it('keeps its order and sections', () => {
    const tools = availableTools({ modeling: true, drawing: true })
    expect(tools.map((t) => t.label)).toEqual([
      'Cut', 'Auto orient',
      'Measure', 'Array', 'Sketch', 'SVG on a face', 'Push and pull', 'Fillet and chamfer', 'Hole for a screw or insert', 'Thread', 'Shell with open faces', 'Named values',
      'Shape on a face', 'Text on a face', 'Subtract a shape',
      'Hollow', 'Repair mesh', 'Simplify mesh',
    ])
    expect([...new Set(tools.map((t) => t.menu))]).toEqual([0, 1, 2, 3])
  })
})

describe('opening a tool', () => {
  it('opens Design for a modeling tool, from any tab', () => {
    openTool('fillet')
    expect(get()).toMatchObject({ workspace: 'prepare', modelMode: 'design', objectTool: 'fillet' })
  })

  it('leaves the mode alone for Cut, Measure, Array and the mesh tools', () => {
    set({ workspace: 'prepare' })
    for (const t of ['cut', 'measure', 'array', 'hollow', 'simplify', 'hole'] as const) {
      expect(opensDesign(t)).toBe(false)
      openTool(t)
      expect(get()).toMatchObject({ modelMode: 'slice', objectTool: t })
    }
  })

  it('never opens Design without modeling tools', () => {
    setCurrentEdition(NO_CAD)
    openTool('measure')
    expect(get().modelMode).toBe('slice')
  })
})

describe('the full engine', () => {
  it('is there at once with a host engine (the desktop app)', () => {
    const call = vi.fn(async () => true)
    setGeomProvider({ call } as unknown as GeomProvider)
    warmFullEngine()
    expect(call).not.toHaveBeenCalled()
    expect(fullEngine()).toBe('ready')
  })

  it('loads the full module once when Design asks, before any call needs it', async () => {
    const loadFull = vi.fn(async () => ({ operations: new Set(['edge.fillet']), call: () => 'full' }))
    const engine = engineModules(async () => ({ operations: new Set(['mesh.repair']), call: () => 'core' }), loadFull)
    expect(await engine.full()).toBe(true)
    expect(await engine.full()).toBe(true)
    expect(loadFull).toHaveBeenCalledTimes(1)
    // Once it is there it takes every call.
    expect(await engine.run('mesh.repair', {})).toBe('full')
  })
})
