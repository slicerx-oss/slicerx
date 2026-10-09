// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Objects card of the Slice sidebar: how many objects are on the plate, one Add button with the Vault, shapes,
// Export and the tools in its menu, compact rows that open into a tree of parts and volumes, and, while a tool such as
// Cut or Paint is open, that tool's panel in the card's place.
import { Block, Button, Menu, MenuItem, SplitButton } from '@slicerx/ui'
import { lazy, Suspense, useRef, useState, type KeyboardEvent } from 'react'
import { useHost } from '../../host'
import { isCadTool, setWorkspace, useApp, set } from '../../state/store'
import { openModelFiles } from '../../state/actions'
import { useTool, setTool } from '../../plate/tools'
import { searchObjects } from '../../plate/object-list'
import { ExportMenu, ObjectMenu, ShapeMenu } from './object-actions'
import { ToolDialogHost, ToolsMenu } from './object-tools'
import { ObjectTransform } from './object-transform'
import { ObjectRow } from './object-row'
import { useMore } from '../../shell/more'
import './objects.css'

const ObjectSettings = lazy(() => import('./object-settings').then((m) => ({ default: m.ObjectSettings })))
const ObjectVolumes = lazy(() => import('./object-volumes').then((m) => ({ default: m.ObjectVolumes })))
const HistoryPanel = lazy(() => import('../../cad/history/history-panel').then((m) => ({ default: m.HistoryPanel })))
const CadPanel = lazy(() => import('../../cad/cad-panel').then((m) => ({ default: m.CadPanel })))
const CutPanel = lazy(() => import('./cut-panel').then((m) => ({ default: m.CutPanel })))
const PaintPanel = lazy(() => import('./paint-panel').then((m) => ({ default: m.PaintPanel })))
const BrimEarsPanel = lazy(() => import('./brim-ears-panel').then((m) => ({ default: m.BrimEarsPanel })))

type Sub = 'add' | 'shape' | 'export' | 'tools' | 'object'

/** "3 on plate", "1 on plate". */
export function onPlate(n: number): string {
  return `${n} on plate`
}

/** One Add button: the file dialog, and in its menu the Vault, shapes, Export, the tools and the object actions. */
function AddButton() {
  const host = useHost()
  const cad = useApp((s) => s.cadTools)
  const hasSel = useApp((s) => s.selection !== null)
  const [menu, setMenu] = useState<Sub | null>(null)
  const close = () => setMenu(null)
  // A submenu takes the Add menu's place under the button.
  const open = (sub: Sub) => () => setMenu(sub)
  return (
    <SplitButton
      size="sm"
      icon="plus"
      data-testid="objects-add-model"
      tip={{ title: 'Add', body: 'Add a model from a file. The arrow has the Vault, shapes, Export and the tools.' }}
      onClick={() => void openModelFiles(host, { fresh: false })}
      menuLabel="More ways to add, export and edit"
      menuOpen={menu !== null}
      onMenu={() => setMenu(menu ? null : 'add')}
      menuProps={{ 'data-testid': 'slice-objects-add-menu' }}
      menu={
        <>
          <Menu open={menu === 'add'} onClose={close} label="Add" align="end">
            <MenuItem icon="library" data-testid="objects-from-vault" onClick={() => (close(), setWorkspace('library'))}>
              From the Vault
            </MenuItem>
            {cad ? (
              <MenuItem icon="shapes" data-testid="add-shape" aria-haspopup="menu" onClick={open('shape')}>
                Add shape
              </MenuItem>
            ) : null}
            <MenuItem icon="export" data-testid="export-menu" aria-haspopup="menu" onClick={open('export')}>
              Export
            </MenuItem>
            <MenuItem icon="magic-wand" aria-haspopup="menu" onClick={open('tools')}>
              Tools
            </MenuItem>
            <MenuItem icon="more" data-testid="object-menu" aria-haspopup="menu" disabled={!hasSel} onClick={open('object')}>
              Object
            </MenuItem>
          </Menu>
          <ShapeMenu open={menu === 'shape'} onClose={close} align="end" />
          <ExportMenu open={menu === 'export'} onClose={close} align="end" />
          <ToolsMenu open={menu === 'tools'} onClose={close} />
          <ObjectMenu open={menu === 'object'} onClose={close} />
        </>
      }
    >
      Add
    </SplitButton>
  )
}

/** The open tool's name for the card header. */
const TOOL_LABEL: Record<string, string> = { cut: 'Cut', paint: 'Paint', brim: 'Brim ears' }

/** While a tool is open its panel takes the card's place; Done or Escape brings the list back where it was. */
function ToolSlot({ children, onDone, label }: { children: React.ReactNode; onDone: () => void; label: string }) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    e.preventDefault()
    onDone()
  }
  return (
    <div className="tool-slot" data-section="objects" data-tool={label} onKeyDown={onKey}>
      <Button size="sm" className="tool-done" data-testid="slice-tool-done" onClick={onDone} tip={{ title: 'Done', body: `Close ${label} and go back to the objects.` }}>
        Done
      </Button>
      <Suspense fallback={<div className="ws-loading" aria-busy="true" />}>{children}</Suspense>
    </div>
  )
}

/** Objects on the plate, with the Add button. A tool that is open shows here instead. */
export function PrepareObjects() {
  const plate = useApp((s) => s.plate)
  const loading = useApp((s) => s.plateLoading)
  const [query, setQuery] = useState('')
  const objectTool = useApp((s) => s.objectTool)
  const tool = useTool()
  // A history step opened for editing gets a fresh panel, even when the same tool is already open.
  const editKey = useApp((s) => (s.historyEdit ? `:${s.historyEdit.objectId}:${s.historyEdit.index}` : ''))
  // The CAD history list loads only for a selected object that has one (or whose step is open).
  const historyOf = useApp((s) => (s.historyEdit ? s.historyEdit.objectId : s.plate.find((p) => p.id === s.selection)?.history ? s.selection : null))
  const more = useMore('object')
  // The list's scroll position comes back with it when a tool closes.
  const scroll = useRef(0)

  const panel = isCadTool(objectTool) ? (
    <CadPanel key={objectTool + editKey} tool={objectTool} />
  ) : objectTool === 'cut' ? (
    <CutPanel />
  ) : tool === 'paint' ? (
    <PaintPanel />
  ) : tool === 'brim' ? (
    <BrimEarsPanel />
  ) : null
  if (panel) {
    const label = TOOL_LABEL[objectTool ?? ''] ?? TOOL_LABEL[tool] ?? 'the tool'
    const done = () => {
      if (objectTool) set({ objectTool: null })
      else setTool('move')
      requestAnimationFrame(() => {
        const body = document.querySelector('.pane-body')
        if (body) body.scrollTop = scroll.current
      })
    }
    return (
      <>
        <ToolSlot onDone={done} label={label}>
          {panel}
        </ToolSlot>
        <ToolDialogHost />
      </>
    )
  }

  const matches = new Map(searchObjects(plate, query).map((m) => [m.id, m]))
  const searching = query.trim() !== ''
  const names = new Map(plate.map((p) => [p.id, p.name]))
  const remember = () => {
    scroll.current = document.querySelector('.pane-body')?.scrollTop ?? 0
  }
  return (
    <Block
      title="Objects"
      icon="cube"
      className="objects-card"
      data-section="objects"
      aside={
        <span className="objs-head" onPointerDownCapture={remember} onKeyDownCapture={remember}>
          {plate.length ? <span className="objs-count">{onPlate(plate.length)}</span> : null}
          <AddButton />
        </span>
      }
    >
      {plate.length > 1 ? (
        <input className="sx-input obj-search" data-testid="objects-search" type="search" value={query} placeholder="Search objects and parts" aria-label="Search objects and parts" onChange={(e) => setQuery(e.target.value)} />
      ) : null}
      {searching && matches.size === 0 ? <p className="sx-small sx-muted">Nothing on the plate matches "{query.trim()}".</p> : null}
      {plate.length === 0 ? (
        loading ? (
          <ul className="objs" data-testid="objects-list">
            <li className="obj loading">
              <span className="obj-thumb" aria-hidden="true">
                <span className="obj-spin" />
              </span>
              <span className="obj-name">Loading</span>
            </li>
          </ul>
        ) : (
          <div className="objs-empty" data-testid="objects-list">
            <p>Nothing on the plate yet.</p>
            <p className="sx-small sx-muted">Drop STL, 3MF or STEP files anywhere.</p>
          </div>
        )
      ) : (
        <ul className="objs" data-testid="objects-list" onPointerDownCapture={remember}>
          {plate.map((p, index) => (matches.has(p.id) ? <ObjectRow key={p.id} entry={p} index={index} count={plate.length} instanceOf={p.instanceOf ? names.get(p.instanceOf) : undefined} match={matches.get(p.id)!} searching={searching} /> : null))}
        </ul>
      )}
      <ObjectTransform />
      {historyOf ? (
        <Suspense fallback={null}>
          <HistoryPanel objectId={historyOf} />
        </Suspense>
      ) : null}
      {more ? (
        <>
          <Suspense fallback={null}>
            <ObjectVolumes />
          </Suspense>
          <Suspense fallback={null}>
            <ObjectSettings />
          </Suspense>
        </>
      ) : null}
      <ToolDialogHost />
    </Block>
  )
}

