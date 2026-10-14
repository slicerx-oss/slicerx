// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's tools on a phone: one lifted bar along the bottom of the view with six fixed slots, each an icon over its
// name: Add, Sketch, Tools, Edit (the open tool and Transform, a sheet that leaves the model in view), Tree (the model
// tree) and More (measure, values and export). Nothing in it scrolls sideways and no slot changes size when pressed.
// While a sketch is open its drawing tools (the two rows of the sketch panel) take the bar's place, with Finish sketch,
// so they stay under the thumb. Undo and redo sit at the top right of the view (PhoneUndo). The same tool list as the
// desktop shelf (shelf-tools.ts) feeds it.
import { Button, Icon, Menu, MenuAnchor, MenuHeading, MenuItem, MenuSeparator, Seg, type IconName } from '@slicerx/ui'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { getCommand, isEnabled, runCommand } from '../../commands/registry'
import { editionHasCad, useEdition } from '../../edition'
import { useFullEngine } from '../../geom/full-engine'
import { useHost } from '../../host'
import { addPrimitive } from '../../plate/edit'
import { repairSelected } from '../../plate/geom-ops'
import { history } from '../../plate/history'
import { setTool, useTool } from '../../plate/tools'
import { hostSlices } from '../../state/model-mode'
import { openModelFiles } from '../../state/actions'
import { isCadTool, set, toast, useApp } from '../../state/store'
import { setSheet, sheets } from '../../shell/pane'
import { requestFinish, useCanFinish, useSketchInUse } from '../../cad/sketches'
import { useSketchMode } from '../../cad/sketch-mode'
import { startFillet } from '../../cad/start-hint'
import { SHAPES } from '../prepare/object-actions'
import { useHistoryCounts } from '../prepare/plate-toolbar'
import { openTool } from './open-tool'
import { setPhoneSketchSlot, usePhoneSketchUsed } from './phone-slot'
import { nextPick } from './shelf'
import { availableTools, nextSlot, pickWords, SHELF_GROUPS, type DialogTool, type ShelfTool } from './shelf-tools'
import { ViewRing } from './view-ring'
import './phone-model.css'

const ToolDialog = lazy(() => import('../prepare/tool-dialog').then((m) => ({ default: m.ToolDialog })))

/** Export in a host that cannot slice, as the desktop shelf's Export menu has it. */
const EXPORTS = [
  { id: 'export-plate-stl', label: 'Whole model as STL', icon: 'export' },
  { id: 'export-plate-obj', label: 'Whole model as OBJ', icon: 'export' },
  { id: 'export-selection-stl', label: 'Selection as STL', icon: 'export' },
  { id: 'export-selection-obj', label: 'Selection as OBJ', icon: 'export' },
  { id: 'project-save', label: 'Project file (.sx3mf)', icon: 'save' },
] as const

/** The sheets the bar opens: the tree's and the tool's, by their pane keys. */
export interface PhoneSheets {
  tree: string
  tool: string
}

type Slot = 'add' | 'tools' | 'more'

function SlotButton({ icon, label, pressed, expanded, onClick, testId, disabled }: { icon: IconName; label: string; pressed?: boolean; expanded?: boolean; onClick: () => void; testId: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="pbar-slot"
      data-testid={testId}
      aria-label={label}
      {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
      {...(expanded !== undefined ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': expanded } : {})}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={22} />
      <span>{label}</span>
    </button>
  )
}

export function PhoneShelf({ sheetKeys }: { sheetKeys: PhoneSheets }) {
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
  const openSheet = useStore(sheets, (s) => s.open)
  const sketching = usePhoneSketchUsed()
  const canFinish = useCanFinish()
  // one primary at a time: Finish sketch while drawing, the panel's Extrude once the profile can make a solid
  const sketchMode = useSketchMode()
  const inUse = useSketchInUse()
  const [menu, setMenu] = useState<Slot | null>(null)
  const tools = availableTools({ modeling, drawing })
  const slotRef = useCallback((el: HTMLDivElement | null) => setPhoneSketchSlot(el), [])
  useEffect(() => () => setPhoneSketchSlot(null), [])
  // The tool sheet sits on the bar wherever the shell puts the view: the bar's top, as a gap above the screen's bottom.
  const barRef = useRef<HTMLDivElement>(null)
  const placeBar = () => {
    const el = barRef.current
    if (el) document.documentElement.style.setProperty('--pbar-top-gap', `${Math.round(window.innerHeight - el.getBoundingClientRect().top)}px`)
  }
  useLayoutEffect(() => {
    const el = barRef.current
    if (!el) return
    const root = document.documentElement
    const place = placeBar
    place()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place)
    ro?.observe(el)
    window.addEventListener('resize', place)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', place)
      root.style.removeProperty('--pbar-top-gap')
    }
  }, [])
  // The sketch's rows make the bar taller in the same render: measured here, before paint, so the sheet never sits on
  // the bar's top row while the size observer waits for a frame (slow on a busy phone).
  useLayoutEffect(placeBar, [sketching])

  // A tool that opens shows its panel in the Edit sheet, low over the view; the sheet goes again when the tool closes,
  // unless the person opened it themselves.
  const toolOpen = isCadTool(objectTool) || objectTool === 'cut'
  const openedByTool = useRef(false)
  useEffect(() => {
    if (toolOpen) {
      if (sheets.getState().open !== sheetKeys.tool) {
        openedByTool.current = true
        setSheet(sheetKeys.tool, true)
      }
    } else if (openedByTool.current) {
      openedByTool.current = false
      setSheet(sheetKeys.tool, false)
    }
  }, [toolOpen, objectTool, sheetKeys.tool])

  const run = (fn: () => Promise<unknown>) => {
    setMenu(null)
    void fn().catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'))
  }
  const off = (t: ShelfTool) => Boolean(t.needsSelection && !hasSel) || (Boolean(t.modeling) && engine === 'loading')
  const choose = (t: ShelfTool) => {
    setMenu(null)
    if (t.run === 'repair') return run(() => repairSelected(host.slicer))
    if (t.tool) openTool(t.tool)
  }
  const toggleMenu = (m: Slot) => setMenu(menu === m ? null : m)
  const toggleSheet = (key: string) => {
    setMenu(null)
    openedByTool.current = false
    setSheet(key, openSheet !== key)
  }

  const [kind, countText] = pickKey.split(':')
  const pick = pickKey ? { kind: kind as 'object' | 'face' | 'round' | 'edge', count: Number(countText) } : null
  const next = nextSlot(tools, pick)
  const sketchTool = tools.find((t) => t.id === 'sketch')
  const inMenu = (id: string) => id !== 'sketch' && id !== 'measure' && id !== 'values'
  const dialog = objectTool === 'simplify' || objectTool === 'hollow' || objectTool === 'hole' ? (objectTool as DialogTool) : null
  const sketchPressed = objectTool === 'sketch' && inUse === null

  return (
    <div className="pbar-wrap">
      <div ref={barRef} className="pbar sx-overlay" role="toolbar" aria-label="Model tools" data-testid="model-shelf" data-sketch={sketching || undefined} aria-busy={engine === 'loading' || undefined}>
        {/* the sketch panel puts its drawing tools here (phone-slot.ts); shown only while it does */}
        <div className="pbar-sketch" ref={slotRef} data-testid="phone-sketch-bar" />
        {sketching ? (
          <div className="pbar-sketch-end">
            <Button size="sm" variant={sketchMode?.ready ? 'default' : 'primary'} icon="check" data-testid="sketch-finish" disabled={!canFinish} onClick={requestFinish}>
              Finish sketch
            </Button>
          </div>
        ) : null}
        <div className="pbar-slots" hidden={sketching}>
          <MenuAnchor className="pbar-anchor">
            <SlotButton icon="plus" label="Add" testId="phone-add" expanded={menu === 'add'} onClick={() => toggleMenu('add')} />
            <Menu open={menu === 'add'} onClose={() => setMenu(null)} label="Add">
              <MenuHeading>New object</MenuHeading>
              {SHAPES.map((s) => (
                <MenuItem key={`o-${s.shape}`} icon={s.icon} onClick={() => run(() => addPrimitive(host.slicer, s.shape, 'object'))}>
                  {s.label}
                </MenuItem>
              ))}
              <MenuItem icon="import" onClick={() => run(() => openModelFiles(host))}>
                Model from a file
              </MenuItem>
              <MenuSeparator />
              <MenuHeading>Part of the selected object</MenuHeading>
              {SHAPES.map((s) => (
                <MenuItem key={`p-${s.shape}`} icon={s.icon} disabled={!hasSel} onClick={() => run(() => addPrimitive(host.slicer, s.shape, 'part'))}>
                  {s.label}
                </MenuItem>
              ))}
            </Menu>
          </MenuAnchor>
          {sketchTool ? <SlotButton icon="sketch" label="Sketch" testId="phone-sketch" pressed={sketchPressed} disabled={off(sketchTool)} onClick={() => choose(sketchTool)} /> : null}
          <MenuAnchor className="pbar-anchor">
            <SlotButton icon="push-pull" label="Tools" testId="phone-tools" expanded={menu === 'tools'} onClick={() => toggleMenu('tools')} />
            <Menu open={menu === 'tools'} onClose={() => setMenu(null)} label="Tools" testId="phone-tools-menu">
              {next.length && pick ? (
                <>
                  <MenuHeading>{`For ${pickWords(pick)}`}</MenuHeading>
                  {next.map((e) => (
                    <MenuItem
                      key={e.chamfer ? 'chamfer' : e.tool.id}
                      icon={e.chamfer ? 'chamfer-edge' : e.tool.icon}
                      disabled={Boolean(e.off) || off(e.tool)}
                      data-next-tool={e.chamfer ? 'chamfer' : e.tool.id}
                      onClick={() => {
                        if (e.chamfer) startFillet('chamfer')
                        choose(e.tool)
                      }}
                    >
                      {e.chamfer ? 'Chamfer' : e.tool.label}
                    </MenuItem>
                  ))}
                  <MenuSeparator />
                </>
              ) : null}
              {SHELF_GROUPS.filter((g) => g.id !== 'utility').map((g) => {
                const list = tools.filter((t) => t.shelf?.group === g.id && inMenu(t.id))
                if (!list.length) return null
                return (
                  <div key={g.id} role="group" aria-label={g.label}>
                    <MenuHeading>{g.label}</MenuHeading>
                    {list.map((t) => (
                      <MenuItem key={t.id} icon={t.icon} disabled={off(t)} data-tool={t.id} aria-pressed={t.tool !== undefined && objectTool === t.tool} onClick={() => choose(t)}>
                        {t.label}
                      </MenuItem>
                    ))}
                  </div>
                )
              })}
            </Menu>
          </MenuAnchor>
          <SlotButton icon="sliders" label="Edit" testId="phone-edit" pressed={openSheet === sheetKeys.tool} onClick={() => toggleSheet(sheetKeys.tool)} />
          <SlotButton icon="list" label="Tree" testId="phone-tree" pressed={openSheet === sheetKeys.tree} onClick={() => toggleSheet(sheetKeys.tree)} />
          <MenuAnchor className="pbar-anchor">
            <SlotButton icon="more" label="More" testId="phone-more" expanded={menu === 'more'} onClick={() => toggleMenu('more')} />
            <Menu open={menu === 'more'} onClose={() => setMenu(null)} label="More" align="end">
              {tools
                .filter((t) => t.id === 'measure' || t.id === 'values')
                .map((t) => (
                  <MenuItem key={t.id} icon={t.icon} disabled={off(t)} onClick={() => choose(t)}>
                    {t.label}
                  </MenuItem>
                ))}
              {hostSlices() ? null : (
                <>
                  <MenuSeparator />
                  <MenuHeading>Export</MenuHeading>
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
                </>
              )}
            </Menu>
          </MenuAnchor>
        </div>
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

/** Undo and redo at the top right of the view on a phone, where the desktop shelf keeps them at its end. */
export function PhoneUndo() {
  const { undo, redo } = useHistoryCounts()
  return (
    <div className="pundo sx-overlay" role="group" aria-label="Undo and redo">
      <Button variant="ghost" icon="undo" aria-label="Undo" data-testid="phone-undo" disabled={undo === 0} onClick={() => history().undo()} />
      <Button variant="ghost" icon="redo" aria-label="Redo" data-testid="phone-redo" disabled={redo === 0} onClick={() => history().redo()} />
    </div>
  )
}

const HANDLES = [
  { value: 'move', label: 'Move', icon: 'move' },
  { value: 'rotate', label: 'Rotate', icon: 'rotate' },
  { value: 'scale', label: 'Scale', icon: 'scale' },
] as const

/**
 * Which handles a finger gets on the selection: Move, Rotate or Scale. Always in its place under the selection pill,
 * off until something is selected, so nothing moves when a model is picked.
 */
export function PhoneHandles() {
  const tool = useTool()
  const hasSel = useApp((s) => s.selection !== null)
  const objectTool = useApp((s) => s.objectTool)
  const value = tool === 'rotate' || tool === 'scale' ? tool : 'move'
  const disabled = !hasSel || objectTool !== null
  return (
    <div className="phandles sx-overlay" data-testid="phone-handles">
      <Seg
        label="Handles"
        size="sm"
        value={value}
        onChange={(v) => setTool(v, true)}
        options={HANDLES.map((h) => ({ value: h.value, label: '', icon: h.icon, title: h.label, disabled, testId: `phone-handle-${h.value}` }))}
      />
    </div>
  )
}
