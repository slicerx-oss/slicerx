// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's tool shelf, a lifted bar over the view: Create, Shape, Fasten and Mesh, set apart by space and a short
// hairline, then the next slot with the tools for what is picked, then Measure and Values as icons by undo and redo.
// A shelf without room for its labels (a narrow window, or the mimir panel open beside it) drops them. The tools come from shelf-tools.ts, the same list as the Tools menu in Slice.
// Modeling tools wait while the full geometry engine loads. A host that cannot slice ends the shelf with Export, the
// only way out for a model there.
import { Button, Icon, Menu, MenuAnchor, MenuHeading, MenuItem, MenuSeparator } from '@slicerx/ui'
import { lazy, Suspense, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { getCommand, isEnabled, runCommand } from '../../commands/registry'
import { editionHasCad, useEdition } from '../../edition'
import { useFullEngine } from '../../geom/full-engine'
import { useHost } from '../../host'
import { addPrimitive } from '../../plate/edit'
import { repairSelected } from '../../plate/geom-ops'
import { history } from '../../plate/history'
import { hostSlices } from '../../state/model-mode'
import { set, toast, useApp, type AppState } from '../../state/store'
import { SHAPES } from '../prepare/object-actions'
import { useHistoryCounts } from '../prepare/plate-toolbar'
import { openTool } from './open-tool'
import { ViewRing } from './view-ring'
import { startFillet } from '../../cad/start-hint'
import { availableTools, nextSlot, pickWords, SHELF_GROUPS, shelfGroup, type DialogTool, type NextEntry, type NextPick, type ShelfGroup, type ShelfTool } from './shelf-tools'

/**
 * 'icons' when the labeled shelf does not fit its own width, so every tool stays in view; back to labels once the
 * width it needed is there again. Only a change of size decides, never a press, so nothing moves under the pointer.
 */
function useShelfFit(ref: RefObject<HTMLDivElement | null>): 'labels' | 'icons' {
  const [fit, setFit] = useState<'labels' | 'icons'>('labels')
  const need = useRef(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const check = () => {
      setFit((f) => {
        if (f === 'labels' && el.scrollWidth > el.clientWidth + 1) {
          need.current = el.scrollWidth
          return 'icons'
        }
        return f === 'icons' && el.clientWidth >= need.current ? 'labels' : f
      })
    }
    const watch = new ResizeObserver(check)
    watch.observe(el)
    return () => watch.disconnect()
  }, [ref])
  return fit
}

const ToolDialog = lazy(() => import('../prepare/tool-dialog').then((m) => ({ default: m.ToolDialog })))

/** What is picked, for the next slot: the faces or edges (round when every one of them is), else the selected objects. */
export function nextPick(s: Pick<AppState, 'subPicks' | 'selection' | 'selectedIds'>): NextPick | null {
  const last = s.subPicks.at(-1)
  if (last) {
    const same = s.subPicks.filter((p) => p.kind === last.kind)
    return { kind: same.every((p) => p.round) ? 'round' : last.kind, count: same.length }
  }
  if (!s.selection) return null
  return { kind: 'object', count: Math.max(1, s.selectedIds.length) }
}

/** Export in a host that cannot slice: the commands behind it, so the menu and the command bar do the same thing. */
const EXPORTS = [
  { id: 'export-plate-stl', label: 'Whole model as STL', icon: 'export' },
  { id: 'export-plate-obj', label: 'Whole model as OBJ', icon: 'export' },
  { id: 'export-selection-stl', label: 'Selection as STL', icon: 'export' },
  { id: 'export-selection-obj', label: 'Selection as OBJ', icon: 'export' },
  { id: 'project-save', label: 'Project file (.sx3mf)', icon: 'save' },
] as const

const MENU_LABEL = { face: { label: 'On a face', icon: 'on-face' }, mesh: { label: 'Mesh', icon: 'mesh-menu' } } as const

export function Shelf() {
  const shelfRef = useRef<HTMLDivElement>(null)
  const fit = useShelfFit(shelfRef)
  const host = useHost()
  const hasSel = useApp((s) => s.selection !== null)
  const pickKey = useApp((s) => {
    const p = nextPick(s)
    return p ? `${p.kind}:${p.count}` : ''
  })
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
  const groupName = (id: ShelfGroup) => SHELF_GROUPS.find((g) => g.id === id)?.label ?? ''
  const tip = (t: ShelfTool) => (t.tip ? { 'data-tip': t.tip } : { 'data-tip-title': `${groupName(t.shelf?.group ?? 'shape')} · ${t.label}` })
  const toolButton = (t: ShelfTool, extra: { className?: string } = {}) => (
    <button key={t.id} type="button" className={extra.className ?? 'shelf-tool'} data-tool={t.id} data-testid="model-shelf-tool" {...tip(t)} aria-label={t.label} aria-pressed={t.tool !== undefined && objectTool === t.tool} disabled={off(t)} onClick={() => choose(t)}>
      <Icon name={t.icon} />
      <span>{t.short ?? t.label}</span>
    </button>
  )
  // The next slot: what to do with the pick, how many are picked, and which tools take that many.
  const [kind, countText] = pickKey.split(':')
  const pick: NextPick | null = pickKey ? { kind: kind as NextPick['kind'], count: Number(countText) } : null
  const next = nextSlot(tools, pick)
  const words = pick ? pickWords(pick) : ''
  const nextButton = (e: NextEntry) => {
    const label = e.chamfer ? 'Chamfer' : e.tool.label
    const short = e.chamfer ? 'Chamfer' : (e.tool.short ?? e.tool.label)
    const disabled = Boolean(e.off) || off(e.tool)
    return (
      <button
        key={e.chamfer ? 'chamfer' : e.tool.id}
        type="button"
        className="shelf-tool"
        data-next-tool={e.chamfer ? 'chamfer' : e.tool.id}
        data-testid="model-shelf-next-tool"
        data-tip-title={`Next for ${words} · ${label}`}
        data-tip-body={e.off ?? `Shown because ${words === '1 object' ? 'an object is' : words.startsWith('1 ') ? `a ${words.slice(2)} is` : `${words} are`} picked: a tool that works on ${words.startsWith('1 ') ? 'it' : 'them'}.`}
        aria-label={label}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (disabled) return
          if (e.chamfer) startFillet('chamfer')
          choose(e.tool)
        }}
      >
        <Icon name={e.chamfer ? 'chamfer-edge' : e.tool.icon} />
        <span>{short}</span>
      </button>
    )
  }
  const dialog = objectTool === 'simplify' || objectTool === 'hollow' || objectTool === 'hole' ? (objectTool as DialogTool) : null

  return (
    <div ref={shelfRef} className="shelf sx-overlay" data-fit={fit} role="toolbar" aria-label="Model tools" data-testid="model-shelf" aria-busy={engine === 'loading' || undefined}>
      {SHELF_GROUPS.filter((g) => g.id !== 'utility').map((g) => (
        <div key={g.id} className="shelf-grp" data-group={g.id}>
          <div className="shelf-tools">
            {shelfGroup(tools, g.id).map((e) =>
              e.kind === 'tool' ? (
                toolButton(e.tool)
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
                  <Icon name="box-shape" />
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
        </div>
      ))}
      {next.length ? (
        <div className="shelf-next" data-testid="model-shelf-next" data-tip-avoid=".shelf-next" aria-label={`For ${words}`} role="group">
          {pick && (pick.kind !== 'object' || pick.count > 1) ? (
            <span className="shelf-pick" data-testid="model-shelf-next-count" aria-label={words} data-tip-title={words}>
              <b>{pick.count}</b>
              <span>{words.slice(String(pick.count).length + 1)}</span>
            </span>
          ) : null}
          {next.map(nextButton)}
        </div>
      ) : null}
      <div className="shelf-end">
        {shelfGroup(tools, 'utility').map((e) => (e.kind === 'tool' ? toolButton(e.tool, { className: 'shelf-tool shelf-icon' }) : null))}
        <span className="shelf-sep" aria-hidden="true" />
        <Button variant="ghost" size="sm" icon="undo" aria-label="Undo" tip="edit.undo" disabled={undo === 0} onClick={() => history().undo()} />
        <Button variant="ghost" size="sm" icon="redo" aria-label="Redo" tip="edit.redo" disabled={redo === 0} onClick={() => history().redo()} />
        {hostSlices() ? null : (
          <>
            <span className="shelf-sep" aria-hidden="true" />
            <MenuAnchor>
              <button type="button" className="shelf-tool" data-testid="model-export" aria-label="Export" aria-haspopup="menu" aria-expanded={menu === 'export'} onClick={() => setMenu(menu === 'export' ? null : 'export')}>
                <Icon name="export" />
                <span>Export</span>
                <Icon name="chevron-down" size={12} />
              </button>
              <Menu open={menu === 'export'} onClose={() => setMenu(null)} label="Export">
                {EXPORTS.map((e) => {
                  const c = getCommand(e.id)
                  return (
                    <MenuItem
                      key={e.id}
                      icon={e.icon}
                      disabled={!c || !isEnabled(c)}
                      onClick={() =>
                        run(async () => {
                          const r = await runCommand(e.id)
                          if (!r.ok) throw new Error(r.message)
                        })
                      }
                    >
                      {e.label}
                    </MenuItem>
                  )
                })}
              </Menu>
            </MenuAnchor>
          </>
        )}
      </div>
      <ViewRing />
      {dialog ? (
        <Suspense fallback={null}>
          <ToolDialog tool={dialog} onClose={() => set({ objectTool: null })} />
        </Suspense>
      ) : null}
    </div>
  )
}
