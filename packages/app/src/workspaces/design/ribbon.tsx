// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's ribbon: Solid, Mesh and Sketch tabs over one row of groups, each tool a shaded icon with its name under it
// (ribbon-layout.ts holds what goes where). Settings > Look and feel > Toolbar size picks 32, 24 or 16 px icons; at 16
// the names become tips. Every tab's row has the same height, so changing tabs, pressing or hovering moves nothing.
// A ribbon without room for its names (a narrow window, or the mimir panel beside it) drops them, the way Small does.
// Undo and redo sit at the end of the tab row. What is picked shows in the groups themselves: a tool that cannot take
// the pick is off, with the reason in its tip.
// On a phone the shelf (shelf.tsx) stays.
import { Button, Icon, Menu, MenuAnchor, MenuHeading, MenuItem, MenuSeparator } from '@slicerx/ui'
import { ToolIcon, type ToolIconName } from '@slicerx/ui/tool-icons'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { getCommand, isEnabled, runCommand } from '../../commands/registry'
import { editionHasCad, useEdition } from '../../edition'
import { useFullEngine } from '../../geom/full-engine'
import { useHost } from '../../host'
import { addPrimitive } from '../../plate/edit'
import { repairSelected } from '../../plate/geom-ops'
import { history } from '../../plate/history'
import { set, toast, useApp } from '../../state/store'
import { SHAPES } from '../prepare/object-actions'
import { useHistoryCounts } from '../prepare/plate-toolbar'
import { modKey } from '../../lib/keys'
import { openTool } from './open-tool'
import { ViewRing } from './view-ring'
import { SelectOtherList } from './select-other-list'
import { startFillet } from '../../cad/start-hint'
import { openSketch, requestFinish, useCanFinish, useSketchDraw, useSketchInUse } from '../../cad/sketches'
import { shownSketches } from './finished-sketches'
import { DRAW_FAMILY, ribbonGroups, ribbonTabs, TOOLBAR_ICON, type RibbonAction, type RibbonItem, type RibbonMenu, type RibbonTab } from './ribbon-layout'
import { availableTools, menuEntryTipAttrs, pickOff, toolTipAttrs, type DialogTool, type NextPick, type ShelfTool } from './shelf-tools'
import { nextPick } from './shelf'
import './ribbon.css'

const ToolDialog = lazy(() => import('../prepare/tool-dialog').then((m) => ({ default: m.ToolDialog })))

/** Export: the commands behind it, so the menu and the command bar do the same thing. */
const EXPORTS = [
  { id: 'export-plate-stl', label: 'Whole model as STL', icon: 'export' as const },
  { id: 'export-plate-obj', label: 'Whole model as OBJ', icon: 'export' as const },
  { id: 'export-selection-stl', label: 'Selection as STL', icon: 'export-selection' as const },
  { id: 'export-selection-obj', label: 'Selection as OBJ', icon: 'export-selection' as const },
  { id: 'project-save', label: 'Project file (.sx3mf)', icon: 'project-file' as const },
]
const SHAPE_ICON: Record<string, ToolIconName> = { box: 'cube', cylinder: 'cylinder', sphere: 'sphere', cone: 'cone' }

/**
 * 'icons' when the ribbon with names does not fit its width, so every tool stays in view; back to names once the width
 * it needed is there again. The widest tab seen at this size decides, so a tab change never changes the ribbon's height,
 * and only a change of size decides, never a press, so nothing moves under the pointer.
 */
function useRibbonFit(ref: RefObject<HTMLDivElement | null>, row: RefObject<HTMLDivElement | null>, key: string): 'labels' | 'icons' {
  const [fit, setFit] = useState<'labels' | 'icons'>('labels')
  const need = useRef(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    setFit('labels')
    need.current = 0
    const check = () => {
      const r = row.current
      if (!r) return
      const pad = parseFloat(getComputedStyle(el).paddingLeft) + parseFloat(getComputedStyle(el).paddingRight)
      const room = el.clientWidth - pad
      const left = r.getBoundingClientRect().left
      let tools = 0
      for (const g of r.children) tools = Math.max(tools, g.getBoundingClientRect().right - left)
      setFit((f) => {
        if (f === 'labels' && tools > room + 1) {
          need.current = Math.max(need.current, tools)
          return 'icons'
        }
        if (f === 'labels') need.current = Math.max(need.current, tools)
        return f === 'icons' && room >= need.current ? 'labels' : f
      })
    }
    const watch = new ResizeObserver(check)
    watch.observe(el)
    watch.observe(row.current ?? el)
    for (const g of row.current?.children ?? []) watch.observe(g)
    const kids = new MutationObserver(() => {
      for (const g of row.current?.children ?? []) watch.observe(g)
      check()
    })
    if (row.current) kids.observe(row.current, { childList: true })
    return () => {
      watch.disconnect()
      kids.disconnect()
    }
  }, [ref, row, key])
  return fit
}

/** One ribbon button: the icon, its name under it (a tip at Small), pressed and off states. */
function RibbonButton({ icon, size, label, tip, pressed, off, primary, menu, testId, data, onClick }: {
  icon: ToolIconName
  size: 32 | 24 | 16
  label: string
  tip?: string | undefined
  pressed?: boolean | undefined
  off?: boolean | string | undefined
  /** The one primary action on screen, in the primary button's look. */
  primary?: boolean | undefined
  menu?: { open: boolean } | undefined
  testId?: string | undefined
  data?: Record<string, string> | undefined
  onClick: () => void
}) {
  const why = typeof off === 'string' ? off : undefined
  return (
    <button
      type="button"
      className="rb-btn"
      data-testid={testId}
      data-variant={primary ? 'primary' : undefined}
      {...data}
      aria-label={label}
      aria-pressed={menu ? undefined : pressed === undefined ? undefined : pressed}
      aria-haspopup={menu ? 'menu' : undefined}
      aria-expanded={menu ? menu.open : undefined}
      aria-disabled={off ? true : undefined}
      data-tip-title={label}
      {...(why ?? tip ? { 'data-tip-body': why ?? tip } : {})}
      onClick={() => {
        if (!off) onClick()
      }}
    >
      <ToolIcon name={icon} size={size} />
      <span className="rb-label">
        {label}
        {menu ? <Icon name="chevron-down" size={10} /> : null}
      </span>
    </button>
  )
}

export function Ribbon() {
  const bodyRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const host = useHost()
  const sizeSetting = useApp((s) => s.appearance.toolbarSize)
  const iconPx = TOOLBAR_ICON[sizeSetting]
  const modeling = editionHasCad(useEdition())
  const drawing = useApp((s) => s.cadTools)
  const tools = availableTools({ modeling, drawing })
  const tabs = ribbonTabs(modeling)
  const [tab, setTab] = useState<RibbonTab>('solid')
  const fit = useRibbonFit(bodyRef, rowRef, sizeSetting)
  const size = fit === 'icons' && sizeSetting !== 'small' ? 'small' : sizeSetting
  const px = fit === 'icons' ? 16 : iconPx
  const hasSel = useApp((s) => s.selection !== null)
  const manySel = useApp((s) => s.selectedIds.length > 1)
  const pickKey = useApp((s) => {
    const p = nextPick(s)
    return p ? `${p.kind}:${p.count}` : ''
  })
  const objectTool = useApp((s) => s.objectTool)
  const sketchToUse = useApp((s) => shownSketches(s.timeline).at(-1)?.id ?? null)
  const engine = useFullEngine()
  const { undo, redo } = useHistoryCounts()
  const [menu, setMenu] = useState<RibbonMenu | null>(null)
  const canFinish = useCanFinish()
  const draw = useSketchDraw()
  // one primary at a time: Finish sketch while the drawing can't make a solid yet, then Extrude in the panel
  const finishPrimary = canFinish && draw !== null && !draw.ready
  // an Extrude or Revolve from a finished sketch runs in the sketch tool, but nobody is sketching
  const pressedTool = useSketchInUse() !== null && objectTool === 'sketch' ? null : objectTool

  // Sketching opens the Sketch tab, and Finish sketch goes back to the tab it came from.
  const before = useRef<RibbonTab | null>(null)
  useEffect(() => {
    if (canFinish && modeling) {
      setTab((t) => {
        if (t !== 'sketch') before.current = t
        return 'sketch'
      })
    } else if (before.current) {
      const back = before.current
      before.current = null
      setTab(back)
    }
  }, [canFinish, modeling])

  const run = (fn: () => Promise<unknown>) => {
    setMenu(null)
    void fn().catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'))
  }
  const command = (id: string) => run(async () => {
    const r = await runCommand(id)
    if (!r.ok) throw new Error(r.message)
  })
  const choose = (t: ShelfTool) => {
    setMenu(null)
    if (t.run === 'repair') return run(() => repairSelected(host.slicer))
    if (t.run === 'orient') return command(t.command)
    if (t.tool) openTool(t.tool)
  }
  // what is picked, so a tool that takes one at a time is off for more, saying why
  const [kind, countText] = pickKey.split(':')
  const pick: NextPick | null = pickKey ? { kind: kind as NextPick['kind'], count: Number(countText) } : null
  const toolOff = (t: ShelfTool): string | false => (t.needsSelection && !hasSel ? 'Select an object first.' : t.modeling && engine === 'loading' ? 'The modeling tools are loading.' : (pickOff(t, pick) ?? false))

  const actionOff = (id: RibbonAction): string | false => {
    if (DRAW_FAMILY[id] || id === 'look') return draw ? false : 'Start a sketch first.'
    if (id === 'mirror') return draw?.mirror ? false : draw ? 'Select a loop in the sketch first.' : 'Start a sketch first.'
    if (id === 'finish') return canFinish ? false : 'Start a sketch first.'
    if (id === 'extrude' || id === 'revolve') return sketchToUse ? (engine === 'loading' ? 'The modeling tools are loading.' : false) : 'Finish a sketch first, then extrude or revolve it.'
    if (id === 'chamfer') return engine === 'loading' ? 'The modeling tools are loading.' : false
    if (id === 'merge') return manySel ? false : 'Select two or more objects to combine.'
    if (id === 'split') return hasSel ? false : 'Select an object first.'
    return false
  }
  const actionPressed = (id: RibbonAction): boolean | undefined => {
    const f = DRAW_FAMILY[id]
    if (f) return draw?.family === f
    if (id === 'mirror') return Boolean(draw?.mirroring)
    return undefined
  }
  const doAction = (id: RibbonAction) => {
    setMenu(null)
    const f = DRAW_FAMILY[id]
    if (f) return draw?.pick(f)
    if (id === 'look') return draw?.look()
    if (id === 'mirror') return draw?.mirror?.()
    if (id === 'finish') return requestFinish()
    if ((id === 'extrude' || id === 'revolve') && sketchToUse) return openSketch({ id: sketchToUse, mode: id })
    if (id === 'chamfer') {
      startFillet('chamfer')
      return openTool('fillet')
    }
    if (id === 'merge') return command('merge-objects')
    if (id === 'split') return command('split-parts')
  }

  const menuItems = (id: RibbonMenu): ReactNode => {
    if (id === 'add') {
      return (
        <>
          <MenuHeading>New object</MenuHeading>
          {SHAPES.map((s) => (
            <MenuItem key={`o-${s.shape}`} iconNode={<ToolIcon name={SHAPE_ICON[s.shape] ?? 'cube'} size={16} />} onClick={() => run(() => addPrimitive(host.slicer, s.shape, 'object'))}>
              {s.label}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuHeading>Part of the selected object</MenuHeading>
          {SHAPES.map((s) => (
            <MenuItem key={`p-${s.shape}`} iconNode={<ToolIcon name={SHAPE_ICON[s.shape] ?? 'cube'} size={16} />} disabled={!hasSel} onClick={() => run(() => addPrimitive(host.slicer, s.shape, 'part'))}>
              {s.label}
            </MenuItem>
          ))}
        </>
      )
    }
    if (id === 'face') {
      return tools.filter((t) => t.shelf?.menu === 'face').map((t) => (
        <MenuItem key={t.id} iconNode={<ToolIcon name={t.toolIcon} size={16} />} {...menuEntryTipAttrs(t)} disabled={Boolean(toolOff(t))} onClick={() => choose(t)}>
          {t.label}
        </MenuItem>
      ))
    }
    return EXPORTS.map((e) => {
      const c = getCommand(e.id)
      return (
        <MenuItem key={e.id} iconNode={<ToolIcon name={e.icon} size={16} />} disabled={!c || !isEnabled(c)} onClick={() => command(e.id)}>
          {e.label}
        </MenuItem>
      )
    })
  }

  const item = (it: RibbonItem, key: string): ReactNode => {
    if (it.kind === 'tool') {
      const t = tools.find((x) => x.id === it.id)
      if (!t) return null
      return (
        <RibbonButton key={key} icon={t.toolIcon} size={px} label={t.short ?? t.label} pressed={t.tool !== undefined && pressedTool === t.tool} off={toolOff(t)} testId="model-shelf-tool" data={{ 'data-tool': t.id, ...toolTipAttrs(t) }} onClick={() => choose(t)} />
      )
    }
    if (it.kind === 'action') {
      return <RibbonButton key={key} icon={it.icon} size={px} label={it.label} tip={it.tip} pressed={actionPressed(it.id)} off={actionOff(it.id)} primary={it.id === 'finish' && finishPrimary} testId={it.id === 'finish' ? 'sketch-finish' : `ribbon-${it.id}`} data={it.id === 'finish' ? { 'data-action': it.id, 'data-tip-key': `${modKey()}Enter` } : { 'data-action': it.id }} onClick={() => doAction(it.id)} />
    }
    const pressed = it.id === 'face' && tools.some((t) => t.shelf?.menu === 'face' && t.tool !== undefined && pressedTool === t.tool)
    return (
      <MenuAnchor key={key}>
        <RibbonButton icon={it.icon} size={px} label={it.label} pressed={pressed} menu={{ open: menu === it.id }} testId={it.id === 'export' ? 'model-export' : `ribbon-menu-${it.id}`} onClick={() => setMenu(menu === it.id ? null : it.id)} />
        <Menu open={menu === it.id} onClose={() => setMenu(null)} label={it.label}>
          {menuItems(it.id)}
        </Menu>
      </MenuAnchor>
    )
  }

  const dialog = objectTool === 'simplify' || objectTool === 'hollow' || objectTool === 'hole' ? (objectTool as DialogTool) : null
  const groups = ribbonGroups(tab, tools, modeling)

  return (
    <div className="ribbon" data-size={size} data-setting={sizeSetting} data-fit={fit} data-tab={tab} role="toolbar" aria-label="Model tools" data-testid="model-shelf" aria-busy={engine === 'loading' || undefined}>
      <div className="rb-tabs">
        <div className="rb-tablist" role="tablist" aria-label="Ribbon tabs">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" className="rb-tab" id={`ribbon-tab-${t.id}`} aria-selected={tab === t.id} aria-controls="ribbon-body" data-testid={`ribbon-tab-${t.id}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="rb-quick">
          <Button variant="ghost" size="sm" icon="undo" aria-label="Undo" tip="edit.undo" disabled={undo === 0} onClick={() => history().undo()} />
          <Button variant="ghost" size="sm" icon="redo" aria-label="Redo" tip="edit.redo" disabled={redo === 0} onClick={() => history().redo()} />
        </div>
      </div>
      <div className="rb-body" id="ribbon-body" role="tabpanel" aria-labelledby={`ribbon-tab-${tab}`} ref={bodyRef}>
        <div className="rb-row" ref={rowRef}>
        {groups.map((g) => (
          <div key={g.id} className="rb-grp" data-group={g.id} role="group" aria-label={g.label}>
            <div className="rb-tools">{g.items.map((it, i) => item(it, `${g.id}-${i}`))}</div>
            <div className="rb-glabel" aria-hidden="true">{g.label}</div>
          </div>
        ))}
        </div>
      </div>
      <ViewRing />
      <SelectOtherList />
      {dialog ? (
        <Suspense fallback={null}>
          <ToolDialog tool={dialog} onClose={() => set({ objectTool: null })} />
        </Suspense>
      ) : null}
    </div>
  )
}
