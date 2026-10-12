// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's menu in the 3D view: a ring of up to six verbs at the pointer for what was right clicked (a part, a face,
// an edge or empty space), with More in the middle for the full list. A touch held still and Shift+F10 open it too
// (the viewport reports all three as `contextpick`). The verbs run the same commands and tools as the shelf and the
// command bar. Delete stays in More: a flick that lands one slice over must never remove a part.
//
// Agents do the same through MCP. Each verb names its tool, or the cad-mcp gap that still lacks one.
import { ContextMenu, MenuItems, RadialMenu, type MenuEntry, type RingItem } from '@slicerx/ui'
import { useStore } from 'zustand'
import { startFillet } from '../../cad/start-hint'
import { runCommand } from '../../commands/registry'
import { editionHasCad, useEdition } from '../../edition'
import { useFullEngine } from '../../geom/full-engine'
import { useHost } from '../../host'
import { addPrimitive } from '../../plate/edit'
import { requestRename, toggleLock, togglePrintable } from '../../plate/object-list'
import { closeViewRing as close, layPickedFace, ringList as showList, viewRing, type RingKind, type RingTarget } from '../../plate/view-ring'
import { openModelFiles } from '../../state/actions'
import { setModelMode, toast, useApp, type AppState } from '../../state/store'
import { SHAPES } from '../prepare/object-actions'
import { openTool } from './open-tool'
import type { ToolId } from './shelf-tools'

/** One verb of a ring, and how an agent does the same: an MCP tool, or the cad-mcp gap that has none yet. */
export interface RingVerb {
  id: string
  label: string
  icon: RingItem['icon']
  /** `slicerx_*` tool, `gap N: what`, or `view` for a change of view an agent has no need of. */
  agent: string
  /** Needs the modeling tools (the edition's CAD and the full engine). */
  modeling?: boolean
}

/** The ring for each target, clockwise from the top. */
export const RING_VERBS: Readonly<Record<RingKind, readonly RingVerb[]>> = {
  object: [
    { id: 'cut', label: 'Cut', icon: 'cut', agent: 'slicerx_geom_cut' },
    { id: 'array', label: 'Array', icon: 'array-linear', agent: 'gap 6: pattern' },
    { id: 'duplicate', label: 'Duplicate', icon: 'duplicate', agent: 'gap 4: duplicate one object' },
    { id: 'drop', label: 'Drop to bed', icon: 'arrow-down', agent: 'gap 4: place one object' },
    { id: 'rename', label: 'Rename', icon: 'rename', agent: 'gap 4: object rename' },
    { id: 'lock', label: 'Lock', icon: 'lock', agent: 'view' },
  ],
  face: [
    { id: 'push', label: 'Push and pull', icon: 'push-pull', agent: 'slicerx_geom_push_pull', modeling: true },
    { id: 'sketch', label: 'Sketch here', icon: 'sketch', agent: 'slicerx_geom_extrude', modeling: true },
    { id: 'shell', label: 'Shell', icon: 'shell-open', agent: 'gap 6: shell', modeling: true },
    { id: 'lay', label: 'Lay on bed', icon: 'lay-flat', agent: 'gap 4: place one object' },
    { id: 'text', label: 'Text', icon: 'text', agent: 'slicerx_geom_emboss', modeling: true },
    { id: 'measure', label: 'Measure', icon: 'measure', agent: 'gap 2: measure' },
  ],
  edge: [
    { id: 'fillet', label: 'Fillet', icon: 'fillet-edge', agent: 'slicerx_geom_fillet', modeling: true },
    { id: 'chamfer', label: 'Chamfer', icon: 'chamfer-edge', agent: 'slicerx_geom_chamfer', modeling: true },
    { id: 'measure', label: 'Measure', icon: 'measure', agent: 'gap 2: measure' },
  ],
  empty: [
    { id: 'shape', label: 'Add shape', icon: 'box-shape', agent: 'slicerx_geom_build' },
    { id: 'model', label: 'Add model', icon: 'plus', agent: 'slicerx_project_add_model' },
    { id: 'arrange', label: 'Arrange', icon: 'arrange', agent: 'slicerx_arrange' },
    { id: 'fit', label: 'Zoom to fit', icon: 'fit', agent: 'view' },
    { id: 'all', label: 'Select all', icon: 'select-all', agent: 'view' },
    { id: 'paste', label: 'Paste', icon: 'paste', agent: 'view' },
  ],
}

export function ViewRing() {
  const { at, target, list } = useStore(viewRing)
  const host = useHost()
  const entry = useApp((s) => (target.kind === 'empty' ? undefined : s.plate.find((p) => p.id === target.objectId)))
  const modeling = editionHasCad(useEdition())
  const engine = useFullEngine()
  if (!at) return null
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error')
  const cmd = (id: string) => () => void runCommand(id).catch(fail)
  const tool = (t: ToolId) => () => openTool(t)
  const runs: Record<string, () => void> = {
    cut: tool('cut'),
    array: tool('array'),
    duplicate: cmd('duplicate'),
    drop: cmd('drop-to-bed'),
    rename: () => entry && requestRename(entry.id),
    lock: () => entry && void toggleLock([entry.id]),
    push: tool('push'),
    sketch: tool('sketch'),
    shell: tool('shell'),
    lay: () => {
      if (entry && !layPickedFace(entry.id)) toast('That face cannot be laid on the bed.', 'error')
    },
    text: tool('facetext'),
    measure: tool('measure'),
    fillet: () => {
      startFillet('fillet')
      openTool('fillet')
    },
    chamfer: () => {
      startFillet('chamfer')
      openTool('fillet')
    },
    // the ring closes before a verb runs, so the list opens again at the ring's point
    shape: () => viewRing.setState({ at, list: true }),
    model: () => void openModelFiles(host).catch(fail),
    arrange: cmd('arrange-all'),
    fit: cmd('zoom-bed'),
    all: cmd('select-all'),
    paste: cmd('paste'),
  }
  const why = (v: RingVerb): string | undefined => {
    if (v.modeling && !modeling) return 'This edition has no modeling tools.'
    if (v.modeling && engine === 'loading') return 'The modeling engine is still loading.'
    if (target.kind === 'object' && entry?.locked && ['cut', 'array', 'drop'].includes(v.id)) return 'Unlock it first.'
    return undefined
  }
  const items: RingItem[] = RING_VERBS[target.kind].map((v) => {
    const reason = why(v)
    const label = v.id === 'lock' && entry?.locked ? 'Unlock' : v.label
    const icon = v.id === 'lock' && entry?.locked ? 'unlock' : v.icon
    return { id: v.id, label, icon, testId: `model-ring-${v.id}`, ...(reason ? { disabled: true, reason } : {}), run: runs[v.id] ?? (() => undefined) }
  })
  const name = target.kind === 'empty' ? 'Plate' : target.kind === 'object' ? (entry?.name ?? 'Object') : target.count > 1 ? `${target.count} ${target.kind}s` : target.kind === 'face' ? 'Face' : 'Edge'
  if (list)
    return (
      <ContextMenu at={at} onClose={close} label={name} testId="model-ring-list" target={target.kind}>
        <MenuItems items={moreEntries(target, items, entry, host)} onClose={close} />
      </ContextMenu>
    )
  return <RadialMenu at={at} onClose={close} label={name} items={items} onMore={showList} testId="model-ring" target={target.kind} />
}

/** The full list behind More: the ring's verbs, then the rest; Delete last, set apart. */
function moreEntries(target: RingTarget, ring: readonly RingItem[], entry: AppState['plate'][number] | undefined, host: ReturnType<typeof useHost>): MenuEntry[] {
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error')
  const cmd = (id: string) => () => void runCommand(id).catch(fail)
  const verbs: MenuEntry[] = ring.filter((r) => r.id !== 'shape').map((r) => ({ id: r.id, label: r.label, icon: r.icon, ...(r.disabled ? { disabled: true } : {}), ...(r.reason ? { reason: r.reason } : {}), testId: `model-ring-list-${r.id}`, run: r.run }))
  if (target.kind === 'object')
    return [
      ...verbs,
      { id: 'printable', label: entry?.printable === false ? 'Print it' : 'Leave out of the print', icon: entry?.printable === false ? 'show' : 'hide', run: () => entry && void togglePrintable([entry.id]) },
      { id: 'split', label: 'Split to objects', icon: 'split', run: cmd('split-objects') },
      { id: 'parts', label: 'Split to parts', icon: 'split', run: cmd('split-parts') },
      { id: 'center', label: 'Center on the bed', icon: 'fit', run: cmd('center-object') },
      { id: 'slice', label: 'Go to Slice with it selected', icon: 'slice', run: () => setModelMode('slice') },
      { id: 'danger', label: 'Remove', children: [{ id: 'delete', label: 'Delete', icon: 'delete', danger: true, shortcut: 'Delete', testId: 'danger-model-ring-delete', run: cmd('plate-remove') }] },
    ]
  if (target.kind === 'face')
    return [
      ...verbs,
      { id: 'shape', label: 'Shape on this face', icon: 'on-face', run: () => openTool('shape') },
      { id: 'svg', label: 'SVG on this face', icon: 'svg-face', run: () => openTool('facesvg') },
    ]
  if (target.kind === 'edge') return verbs
  return [
    { id: 'shapes', label: 'Add a shape', children: SHAPES.map((s) => ({ id: `shape-${s.shape}`, label: s.label, icon: s.icon, testId: `model-ring-list-shape-${s.shape}`, run: () => void addPrimitive(host.slicer, s.shape, 'object').catch(fail) })) },
    ...verbs,
  ]
}
