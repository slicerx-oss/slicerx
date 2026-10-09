// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The modeling and mesh tools as data: Design's shelf groups them, the Tools menu in Slice lists the same entries in
// its own order, and the command bar gates each tool's command by the same flags, so none of them drift. Each entry
// opens a tool panel (`tool`) or runs at once (`run`).
import type { IconName } from '@slicerx/ui'
import type { CadTool } from '../../state/store'

export type ShelfGroup = 'create' | 'shape' | 'fasten' | 'mesh' | 'utility'
/** What a tool can start from: a picked object, face or edge. The shelf's next slot offers the tools for the pick. */
export type PickKind = 'object' | 'face' | 'round' | 'edge'
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
  /** The picks it starts from, in the next slot's order for each. */
  accepts?: readonly PickKind[]
}

export const SHELF_TOOLS: readonly ShelfTool[] = [
  { id: 'cut', label: 'Cut', icon: 'cut', tool: 'cut', needsSelection: true, shelf: { group: 'shape' }, menu: 0, command: 'object-cut', accepts: ['object'] },
  { id: 'orient', label: 'Auto orient', icon: 'orient', run: 'orient', needsSelection: true, menu: 0, command: 'object-orient' },
  { id: 'measure', label: 'Measure', icon: 'measure', tool: 'measure', shelf: { group: 'utility' }, menu: 1, command: 'object-measure' },
  { id: 'array', label: 'Array', icon: 'array-linear', tool: 'array', needsSelection: true, shelf: { group: 'shape' }, menu: 1, command: 'object-array', accepts: ['object'] },
  { id: 'sketch', label: 'Sketch', icon: 'sketch', tool: 'sketch', tip: 'sketch.enter', modeling: true, shelf: { group: 'create' }, menu: 1, command: 'object-sketch', accepts: ['face'] },
  { id: 'facesvg', label: 'SVG on a face', icon: 'svg-face', tool: 'facesvg', tip: 'cad.svgFace', modeling: true, shelf: { group: 'create', menu: 'face' }, menu: 1, command: 'object-svg-face' },
  { id: 'push', label: 'Push and pull', icon: 'push-pull', tool: 'push', tip: 'cad.push', modeling: true, shelf: { group: 'shape' }, menu: 1, command: 'object-push', accepts: ['face'] },
  { id: 'fillet', label: 'Fillet and chamfer', short: 'Fillet', icon: 'fillet-edge', tool: 'fillet', tip: 'cad.fillet', modeling: true, shelf: { group: 'shape' }, menu: 1, command: 'object-fillet', accepts: ['edge'] },
  { id: 'holefit', label: 'Hole for a screw or insert', short: 'Hole', icon: 'hole-fit', tool: 'holefit', modeling: true, shelf: { group: 'fasten' }, menu: 1, command: 'object-holefit', accepts: ['round', 'object'] },
  { id: 'thread', label: 'Thread', icon: 'thread-bolt', tool: 'thread', modeling: true, shelf: { group: 'fasten' }, menu: 1, command: 'object-thread', accepts: ['round'] },
  { id: 'shell', label: 'Shell with open faces', short: 'Shell', icon: 'shell-open', tool: 'shell', modeling: true, shelf: { group: 'shape' }, menu: 1, command: 'object-shell', accepts: ['face'] },
  { id: 'values', label: 'Named values', short: 'Values', icon: 'named-values', tool: 'values', modeling: true, shelf: { group: 'utility' }, menu: 1, command: 'project-values' },
  { id: 'shape', label: 'Shape on a face', icon: 'on-face', tool: 'shape', modeling: true, drawing: true, shelf: { group: 'create', menu: 'face' }, menu: 2, command: 'object-shape' },
  { id: 'facetext', label: 'Text on a face', icon: 'text', tool: 'facetext', modeling: true, drawing: true, shelf: { group: 'create', menu: 'face' }, menu: 2, command: 'object-text' },
  { id: 'subtract', label: 'Subtract a shape', short: 'Subtract', icon: 'subtract-shape', tool: 'hole', needsSelection: true, drawing: true, shelf: { group: 'shape' }, menu: 2, command: 'object-subtract' },
  { id: 'hollow', label: 'Hollow', icon: 'hollow', tool: 'hollow', needsSelection: true, shelf: { group: 'mesh', menu: 'mesh' }, menu: 3, command: 'object-hollow' },
  { id: 'repair', label: 'Repair mesh', icon: 'repair-mesh', run: 'repair', needsSelection: true, shelf: { group: 'mesh', menu: 'mesh' }, menu: 3, command: 'object-repair' },
  { id: 'simplify', label: 'Simplify mesh', icon: 'simplify-mesh', tool: 'simplify', needsSelection: true, shelf: { group: 'mesh', menu: 'mesh' }, menu: 3, command: 'object-simplify' },
]

/** The shelf's groups, in order, set apart by space and a short hairline. The name shows in each tool's tip. Utility (Measure, Values) sits at the right end, as icons, by undo and redo. */
export const SHELF_GROUPS: readonly { id: ShelfGroup; label: string }[] = [
  { id: 'create', label: 'Create' },
  { id: 'shape', label: 'Shape' },
  { id: 'fasten', label: 'Fasten' },
  { id: 'mesh', label: 'Mesh' },
  { id: 'utility', label: 'Inspect' },
]

/** Shelf order inside each group, by id; menus sit where their first entry would. */
const SHELF_ORDER = ['sketch', 'add', 'face', 'push', 'fillet', 'shell', 'subtract', 'cut', 'array', 'holefit', 'thread', 'mesh', 'measure', 'values']

/** Up to three tools for what is picked, for the shelf's next slot: none when nothing is. */
export function nextTools(tools: readonly ShelfTool[], pick: PickKind | null): ShelfTool[] {
  if (!pick) return []
  const order = NEXT_ORDER[pick]
  return tools.filter((t) => t.accepts?.includes(pick)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).slice(0, 3)
}

/** The next slot's order for each pick (the plan's): face push, sketch, shell; object cut, array, hole. */
const NEXT_ORDER: Record<PickKind, readonly string[]> = {
  face: ['push', 'sketch', 'shell'],
  round: ['holefit', 'thread'],
  edge: ['fillet'],
  object: ['cut', 'array', 'holefit'],
}

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

/** A tool's short name, as the shelf shows it. */
export function toolLabel(tool: ToolId): string {
  const t = SHELF_TOOLS.find((x) => x.tool === tool)
  return t?.short ?? t?.label ?? 'A tool'
}

/** Tools that model a part: choosing one from Slice opens Design. Cut, Measure, Array and the mesh tools work in both. */
export function opensDesign(tool: ToolId): boolean {
  return tool !== 'cut' && tool !== 'measure' && tool !== 'array' && tool !== 'hole' && tool !== 'hollow' && tool !== 'simplify'
}
