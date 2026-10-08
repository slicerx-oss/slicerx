// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The modeling and mesh tools as data: Design's shelf groups them, the Tools menu in Slice lists the same entries in
// its own order, and the command bar gates each tool's command by the same flags, so none of them drift. Each entry
// opens a tool panel (`tool`) or runs at once (`run`).
import type { IconName } from '@slicerx/ui'
import type { CadTool } from '../../state/store'

export type ShelfGroup = 'create' | 'modify' | 'fasten' | 'inspect'
export type DialogTool = 'simplify' | 'hollow' | 'hole'
export type ToolId = CadTool | DialogTool | 'cut'
export type ShelfAction = 'orient' | 'repair'

export interface ShelfTool {
  id: string
  /** The menu's name for it, which the shelf shortens to `short`. */
  label: string
  short?: string
  icon: IconName
  tool?: ToolId
  run?: ShelfAction
  tip?: string
  /** Works on the selected object, so it waits for one. */
  needsSelection?: boolean
  /** Ships only with the modeling tools (the edition's CAD switch). */
  modeling?: boolean
  /** Hidden when Settings turns the drawing tools off. */
  drawing?: boolean
  /** Its place on the shelf: a group, or a menu inside one. No shelf place: Slice's menu only. */
  shelf?: { group: ShelfGroup; menu?: 'face' | 'mesh' }
  /** Its place in the Tools menu: the section (separators between) and the order in it. */
  menu: number
  /** Its command bar entry (plate/commands.ts), which takes the edition, drawing and selection gates from here. */
  command: string
}

export const SHELF_TOOLS: readonly ShelfTool[] = [
  { id: 'cut', label: 'Cut', icon: 'cut', tool: 'cut', needsSelection: true, shelf: { group: 'modify' }, menu: 0, command: 'object-cut' },
  { id: 'orient', label: 'Auto orient', icon: 'orient', run: 'orient', needsSelection: true, menu: 0, command: 'object-orient' },
  { id: 'measure', label: 'Measure', icon: 'measure', tool: 'measure', shelf: { group: 'inspect' }, menu: 1, command: 'object-measure' },
  { id: 'array', label: 'Array', icon: 'grid', tool: 'array', needsSelection: true, shelf: { group: 'inspect' }, menu: 1, command: 'object-array' },
  { id: 'sketch', label: 'Sketch', icon: 'ruler', tool: 'sketch', tip: 'sketch.enter', modeling: true, shelf: { group: 'create' }, menu: 1, command: 'object-sketch' },
  { id: 'facesvg', label: 'SVG on a face', icon: 'svg-face', tool: 'facesvg', tip: 'cad.svgFace', modeling: true, shelf: { group: 'create', menu: 'face' }, menu: 1, command: 'object-svg-face' },
  { id: 'push', label: 'Push and pull', icon: 'push-pull', tool: 'push', tip: 'cad.push', modeling: true, shelf: { group: 'modify' }, menu: 1, command: 'object-push' },
  { id: 'fillet', label: 'Fillet and chamfer', short: 'Fillet', icon: 'fillet-edge', tool: 'fillet', tip: 'cad.fillet', modeling: true, shelf: { group: 'modify' }, menu: 1, command: 'object-fillet' },
  { id: 'holefit', label: 'Hole for a screw or insert', short: 'Hole', icon: 'hole-fit', tool: 'holefit', modeling: true, shelf: { group: 'fasten' }, menu: 1, command: 'object-holefit' },
  { id: 'thread', label: 'Thread', icon: 'thread-bolt', tool: 'thread', modeling: true, shelf: { group: 'fasten' }, menu: 1, command: 'object-thread' },
  { id: 'shell', label: 'Shell with open faces', short: 'Shell', icon: 'shell-open', tool: 'shell', modeling: true, shelf: { group: 'modify' }, menu: 1, command: 'object-shell' },
  { id: 'values', label: 'Named values', short: 'Values', icon: 'named-values', tool: 'values', modeling: true, shelf: { group: 'inspect' }, menu: 1, command: 'project-values' },
  { id: 'shape', label: 'Shape on a face', icon: 'on-face', tool: 'shape', modeling: true, drawing: true, shelf: { group: 'create', menu: 'face' }, menu: 2, command: 'object-shape' },
  { id: 'facetext', label: 'Text on a face', icon: 'text', tool: 'facetext', modeling: true, drawing: true, shelf: { group: 'create', menu: 'face' }, menu: 2, command: 'object-text' },
  { id: 'subtract', label: 'Subtract a shape', short: 'Subtract', icon: 'subtract-shape', tool: 'hole', needsSelection: true, drawing: true, shelf: { group: 'modify' }, menu: 2, command: 'object-subtract' },
  { id: 'hollow', label: 'Hollow', icon: 'hollow', tool: 'hollow', needsSelection: true, shelf: { group: 'inspect', menu: 'mesh' }, menu: 3, command: 'object-hollow' },
  { id: 'repair', label: 'Repair mesh', icon: 'settings-reset', run: 'repair', needsSelection: true, shelf: { group: 'inspect', menu: 'mesh' }, menu: 3, command: 'object-repair' },
  { id: 'simplify', label: 'Simplify mesh', icon: 'simplify-mesh', tool: 'simplify', needsSelection: true, shelf: { group: 'inspect', menu: 'mesh' }, menu: 3, command: 'object-simplify' },
]

export const SHELF_GROUPS: readonly { id: ShelfGroup; label: string }[] = [
  { id: 'create', label: 'Create' },
  { id: 'modify', label: 'Modify' },
  { id: 'fasten', label: 'Fasten' },
  { id: 'inspect', label: 'Inspect' },
]

/** Shelf order inside each group, by id; menus sit where their first entry would. */
const SHELF_ORDER = ['sketch', 'face', 'add', 'push', 'fillet', 'shell', 'subtract', 'cut', 'holefit', 'thread', 'array', 'measure', 'values', 'mesh']

/** The tools this build and these settings offer. */
export function availableTools(o: { modeling: boolean; drawing: boolean }): ShelfTool[] {
  return SHELF_TOOLS.filter((t) => (!t.modeling || o.modeling) && (!t.drawing || o.drawing))
}

/** One group's shelf: single tools and the menus (On a face, Mesh) in shelf order. */
export function shelfGroup(tools: readonly ShelfTool[], group: ShelfGroup): ({ kind: 'tool'; tool: ShelfTool } | { kind: 'menu'; menu: 'face' | 'mesh'; tools: ShelfTool[] })[] {
  const out: ({ kind: 'tool'; tool: ShelfTool } | { kind: 'menu'; menu: 'face' | 'mesh'; tools: ShelfTool[] })[] = []
  const inGroup = tools.filter((t) => t.shelf?.group === group)
  const keyOf = (t: ShelfTool) => t.shelf?.menu ?? t.id
  const keys = [...new Set(inGroup.map(keyOf))].sort((a, b) => SHELF_ORDER.indexOf(a) - SHELF_ORDER.indexOf(b))
  for (const k of keys) {
    const items = inGroup.filter((t) => keyOf(t) === k)
    if (k === 'face' || k === 'mesh') out.push({ kind: 'menu', menu: k, tools: items })
    else out.push({ kind: 'tool', tool: items[0]! })
  }
  return out
}

/** Tools that model a part: choosing one from Slice opens Design. Cut, Measure, Array and the mesh tools work in both. */
export function opensDesign(tool: ToolId): boolean {
  return tool !== 'cut' && tool !== 'measure' && tool !== 'array' && tool !== 'hole' && tool !== 'hollow' && tool !== 'simplify'
}
