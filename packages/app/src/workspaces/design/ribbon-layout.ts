// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model ribbon as data: its tabs, their groups and what sits in each. A tool is a shelf tool by id (shelf-tools.ts
// holds what it does and its gates); an action is a ribbon button with its own behavior (ribbon.tsx); a menu opens a
// list. Changing an icon or moving a tool is a change here, not in the component.
import type { ToolIconName } from '@slicerx/ui/tool-icons'
import type { ShelfTool } from './shelf-tools'

export type RibbonTab = 'solid' | 'mesh' | 'sketch'
/** Settings > Look and feel > Toolbar size: Large shows 32 px icons, Medium 24, Small 16 with the labels as tips. */
export type ToolbarSize = 'large' | 'medium' | 'small'
export const TOOLBAR_ICON: Readonly<Record<ToolbarSize, 32 | 24 | 16>> = { large: 32, medium: 24, small: 16 }

/** Ribbon buttons that are not shelf tools. */
export type RibbonAction =
  | 'extrude' | 'revolve' | 'chamfer' | 'merge' | 'split' | 'finish' | 'look' | 'mirror'
  | 'draw-select' | 'draw-line' | 'draw-rect' | 'draw-circle' | 'draw-arc' | 'draw-polygon' | 'draw-slot' | 'draw-trim' | 'draw-dimension'
export type RibbonMenu = 'add' | 'face' | 'export'

export type RibbonItem =
  | { kind: 'tool'; id: string }
  | { kind: 'action'; id: RibbonAction; label: string; icon: ToolIconName; tip: string; modeling?: true }
  | { kind: 'menu'; id: RibbonMenu; label: string; icon: ToolIconName }

export interface RibbonGroup {
  id: string
  label: string
  items: readonly RibbonItem[]
}

const tool = (id: string): RibbonItem => ({ kind: 'tool', id })
const act = (id: RibbonAction, label: string, icon: ToolIconName, tip: string, modeling = true): RibbonItem => ({ kind: 'action', id, label, icon, tip, ...(modeling ? { modeling: true as const } : {}) })
const draw = (id: RibbonAction, label: string, icon: ToolIconName, tip: string) => act(id, label, icon, tip)

const EXTRUDE = act('extrude', 'Extrude', 'extrude', 'Extrude the last finished sketch into a solid.')
const REVOLVE = act('revolve', 'Revolve', 'revolve', 'Revolve the last finished sketch around an axis.')
const EXPORT: RibbonItem = { kind: 'menu', id: 'export', label: 'Export', icon: 'export' }

export const RIBBON: Readonly<Record<RibbonTab, readonly RibbonGroup[]>> = {
  solid: [
    { id: 'create', label: 'Create', items: [tool('sketch'), EXTRUDE, REVOLVE, { kind: 'menu', id: 'add', label: 'Add shape', icon: 'box-shape' }, { kind: 'menu', id: 'face', label: 'On a face', icon: 'on-face' }] },
    {
      id: 'modify',
      label: 'Modify',
      items: [tool('push'), tool('fillet'), act('chamfer', 'Chamfer', 'chamfer', 'Bevel the picked edges flat.'), tool('shell'), tool('holefit'), tool('thread'), tool('subtract'), tool('cut'), tool('array'), act('merge', 'Combine', 'merge', 'Merge the selected objects into one.', false), act('split', 'Split', 'split', 'Split the selected object into its parts.', false)],
    },
    { id: 'inspect', label: 'Inspect', items: [tool('measure'), tool('values')] },
    { id: 'output', label: 'Output', items: [EXPORT] },
  ],
  mesh: [
    { id: 'repair', label: 'Repair', items: [tool('repair'), tool('simplify'), tool('hollow'), tool('orient')] },
    { id: 'separate', label: 'Separate', items: [tool('cut'), act('split', 'Split', 'split', 'Split the selected object into its parts.', false)] },
    { id: 'inspect', label: 'Inspect', items: [tool('measure')] },
    { id: 'output', label: 'Output', items: [EXPORT] },
  ],
  sketch: [
    { id: 'sketch', label: 'Sketch', items: [tool('sketch'), act('finish', 'Finish sketch', 'sketch-finish', 'Keeps the sketch in the timeline without making a solid.')] },
    {
      id: 'draw',
      label: 'Draw',
      items: [
        draw('draw-select', 'Select', 'select-object', 'Pick curves and points in the sketch.'),
        draw('draw-line', 'Line', 'sk-line', 'Line (L)'),
        draw('draw-rect', 'Rectangle', 'sk-rect', 'Rectangle (R)'),
        draw('draw-circle', 'Circle', 'sk-circle', 'Circle (C)'),
        draw('draw-arc', 'Arc', 'sk-arc', 'Arc'),
        draw('draw-polygon', 'Polygon', 'sk-polygon', 'Polygon'),
        draw('draw-slot', 'Slot', 'sk-slot', 'Slot'),
      ],
    },
    { id: 'edit', label: 'Edit', items: [draw('draw-trim', 'Trim', 'trim', 'Trim (T)'), draw('draw-dimension', 'Dimension', 'dimension', 'Dimension (D)'), act('mirror', 'Mirror', 'mirror', 'Mirror the selected loop across a straight line.')] },
    { id: 'make', label: 'Make', items: [act('look', 'Look at', 'look-at', 'Turn the view square on to the sketch.'), EXTRUDE, REVOLVE] },
  ],
}

export const RIBBON_TABS: readonly { id: RibbonTab; label: string; modeling?: true }[] = [
  { id: 'solid', label: 'Solid' },
  { id: 'mesh', label: 'Mesh' },
  { id: 'sketch', label: 'Sketch', modeling: true },
]

/** The draw family each Sketch tab button picks in the open sketch editor. */
export const DRAW_FAMILY: Partial<Record<RibbonAction, string>> = {
  'draw-select': 'select', 'draw-line': 'line', 'draw-rect': 'rect', 'draw-circle': 'circle', 'draw-arc': 'arc',
  'draw-polygon': 'polygon', 'draw-slot': 'slot', 'draw-trim': 'trim', 'draw-dimension': 'dimension',
}

/** A tab's groups with the items this build and these settings offer, empty groups dropped. */
export function ribbonGroups(tab: RibbonTab, tools: readonly ShelfTool[], modeling: boolean): RibbonGroup[] {
  const has = (it: RibbonItem) => (it.kind === 'tool' ? tools.some((t) => t.id === it.id) : it.kind === 'action' ? modeling || !it.modeling : it.id !== 'face' || tools.some((t) => t.shelf?.menu === 'face'))
  return RIBBON[tab].map((g) => ({ ...g, items: g.items.filter(has) })).filter((g) => g.items.length > 0)
}

/** The tabs this build offers: Sketch only with the modeling tools. */
export function ribbonTabs(modeling: boolean): readonly { id: RibbonTab; label: string }[] {
  return RIBBON_TABS.filter((t) => modeling || !t.modeling)
}
