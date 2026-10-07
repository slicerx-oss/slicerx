// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Design's tool shelf: Create, Modify, Fasten and Inspect, each a row of labeled tools over its group name, with undo
// and redo at the end. Narrow windows drop the labels. The tools come from shelf-tools.ts, the same list as the Tools
// menu in Slice. Modeling tools wait while the full geometry engine loads.
import { Button, Icon, Menu, MenuAnchor, MenuHeading, MenuItem, MenuSeparator } from '@slicerx/ui'
import { lazy, Suspense, useState } from 'react'
import { editionHasCad, useEdition } from '../../edition'
import { useFullEngine } from '../../geom/full-engine'
import { useHost } from '../../host'
import { addPrimitive } from '../../plate/edit'
import { repairSelected } from '../../plate/geom-ops'
import { history } from '../../plate/history'
import { set, toast, useApp } from '../../state/store'
import { SHAPES } from '../prepare/object-actions'
import { useHistoryCounts } from '../prepare/plate-toolbar'
import { openTool } from './open-tool'
import { availableTools, SHELF_GROUPS, shelfGroup, type DialogTool, type ShelfTool } from './shelf-tools'

const ToolDialog = lazy(() => import('../prepare/tool-dialog').then((m) => ({ default: m.ToolDialog })))

const MENU_LABEL = { face: { label: 'On a face', icon: 'on-face' }, mesh: { label: 'Mesh', icon: 'magic-wand' } } as const

export function Shelf() {
  const host = useHost()
  const hasSel = useApp((s) => s.selection !== null)
  const objectTool = useApp((s) => s.objectTool)
  const drawing = useApp((s) => s.cadTools)
  const modeling = editionHasCad(useEdition())
  const engine = useFullEngine()
  const { undo, redo } = useHistoryCounts()
  const [menu, setMenu] = useState<string | null>(null)
  const tools = availableTools({ modeling, drawing })
  const run = (fn: () => Promise<unknown>) => {
    setMenu(null)
    void fn().catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'))
  }
  const choose = (t: ShelfTool) => {
    setMenu(null)
    if (t.run === 'repair') return run(() => repairSelected(host.slicer))
    if (t.tool) openTool(t.tool)
  }
  const off = (t: ShelfTool) => Boolean(t.needsSelection && !hasSel) || (Boolean(t.modeling) && engine === 'loading')
  const dialog = objectTool === 'simplify' || objectTool === 'hollow' || objectTool === 'hole' ? (objectTool as DialogTool) : null

  return (
    <div className="shelf" role="toolbar" aria-label="Design tools" aria-busy={engine === 'loading' || undefined}>
      {SHELF_GROUPS.map((g) => (
        <div key={g.id} className="shelf-grp">
          <div className="shelf-tools">
            {shelfGroup(tools, g.id).map((e) =>
              e.kind === 'tool' ? (
                <button key={e.tool.id} type="button" className="shelf-tool" data-tool={e.tool.id} {...(e.tool.tip ? { 'data-tip': e.tool.tip } : { 'data-tip-title': e.tool.label })} aria-label={e.tool.label} aria-pressed={e.tool.tool !== undefined && objectTool === e.tool.tool} disabled={off(e.tool)} onClick={() => choose(e.tool)}>
                  <Icon name={e.tool.icon} />
                  <span>{e.tool.short ?? e.tool.label}</span>
                </button>
              ) : (
                <MenuAnchor key={e.menu}>
                  <button type="button" className="shelf-tool" aria-label={MENU_LABEL[e.menu].label} aria-haspopup="menu" aria-expanded={menu === e.menu} aria-pressed={e.tools.some((t) => t.tool !== undefined && objectTool === t.tool)} onClick={() => setMenu(menu === e.menu ? null : e.menu)}>
                    <Icon name={MENU_LABEL[e.menu].icon} />
                    <span>{MENU_LABEL[e.menu].label}</span>
                    <Icon name="chevron-down" size={12} />
                  </button>
                  <Menu open={menu === e.menu} onClose={() => setMenu(null)} label={MENU_LABEL[e.menu].label}>
                    {e.tools.map((t) => (
                      <MenuItem key={t.id} icon={t.icon} disabled={off(t)} onClick={() => choose(t)}>
                        {t.label}
                      </MenuItem>
                    ))}
                  </Menu>
                </MenuAnchor>
              ),
            )}
            {g.id === 'create' ? (
              <MenuAnchor>
                <button type="button" className="shelf-tool" aria-label="Add a shape" aria-haspopup="menu" aria-expanded={menu === 'add'} onClick={() => setMenu(menu === 'add' ? null : 'add')}>
                  <Icon name="cube" />
                  <span>Add</span>
                  <Icon name="chevron-down" size={12} />
                </button>
                <Menu open={menu === 'add'} onClose={() => setMenu(null)} label="Add a shape">
                  <MenuHeading>New object</MenuHeading>
                  {SHAPES.map((s) => (
                    <MenuItem key={`o-${s.shape}`} icon={s.icon} onClick={() => run(() => addPrimitive(host.slicer, s.shape, 'object'))}>
                      {s.label}
                    </MenuItem>
                  ))}
                  <MenuSeparator />
                  <MenuHeading>Part of the selected object</MenuHeading>
                  {SHAPES.map((s) => (
                    <MenuItem key={`p-${s.shape}`} icon={s.icon} disabled={!hasSel} onClick={() => run(() => addPrimitive(host.slicer, s.shape, 'part'))}>
                      {s.label}
                    </MenuItem>
                  ))}
                </Menu>
              </MenuAnchor>
            ) : null}
          </div>
          <span className="shelf-label">{g.label}</span>
        </div>
      ))}
      <div className="shelf-end">
        <Button variant="ghost" size="sm" icon="undo" aria-label="Undo" tip="edit.undo" disabled={undo === 0} onClick={() => history().undo()} />
        <Button variant="ghost" size="sm" icon="redo" aria-label="Redo" tip="edit.redo" disabled={redo === 0} onClick={() => history().redo()} />
      </div>
      {dialog ? (
        <Suspense fallback={null}>
          <ToolDialog tool={dialog} onClose={() => set({ objectTool: null })} />
        </Suspense>
      ) : null}
    </div>
  )
}
