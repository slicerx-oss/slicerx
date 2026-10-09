// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model tree: each object on the plate with its history steps under it (a sketch as a sub-row under its
// extrude), then its parts and volumes. The selected object, and one whose step is open, start expanded.
// Steps use the same rows and operations as the history list in Slice (cad/history), so nothing new is stored.
// It is a tree to the keyboard: one row is in the tab order, Up and Down move between rows, Right opens an object or
// goes into it (on a step, to its More button), Left closes it or goes back to its object, and Home and End jump.
import { Icon, useContextMenu } from '@slicerx/ui'
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { HistorySteps } from '../../cad/history/history-panel'
import { selectObject } from '../../plate/edit'
import { MAX_NAME, renameObject } from '../../plate/object-list'
import { get, useApp, type PlateEntry } from '../../state/store'
import { ObjectMenu } from './context-menus'

const ROW = '[data-tree-row]'

/** The tree's rows in order. Rows inside a closed object are not drawn, so they are not here either. */
function rows(tree: HTMLElement): HTMLElement[] {
  return [...tree.querySelectorAll<HTMLElement>(ROW)].filter((el) => !(el as HTMLButtonElement).disabled)
}

/** Arrow keys on the tree. Exported for its test. */
export function treeKey(tree: HTMLElement, e: Pick<KeyboardEvent, 'key' | 'target' | 'preventDefault'>, toggle: (objectId: string, open: boolean) => void): void {
  const target = e.target as HTMLElement
  const list = rows(tree)
  const row = target.closest<HTMLElement>(ROW) ?? target.closest('.cad-step')?.querySelector<HTMLElement>(ROW) ?? null
  const i = row ? list.indexOf(row) : -1
  const obj = target.closest<HTMLElement>('.dtree-obj')
  const onObject = row?.classList.contains('dtree-name') ?? false
  const go = (el: HTMLElement | null | undefined) => {
    if (!el) return
    e.preventDefault()
    el.focus()
  }
  if (e.key === 'ArrowDown') go(list[i + 1])
  else if (e.key === 'ArrowUp') go(list[Math.max(0, i - 1)])
  else if (e.key === 'Home') go(list[0])
  else if (e.key === 'End') go(list[list.length - 1])
  else if (e.key === 'ArrowRight' && obj) {
    const id = obj.dataset['objectId']!
    if (onObject && obj.dataset['open'] === undefined) {
      e.preventDefault()
      toggle(id, true)
    } else if (onObject) go(list[i + 1])
    else if (target === row) go(target.closest('.cad-step')?.querySelector<HTMLElement>('.cad-step-more-btn'))
  } else if (e.key === 'ArrowLeft' && obj) {
    const id = obj.dataset['objectId']!
    if (row && target !== row) go(row)
    else if (onObject && obj.dataset['open'] !== undefined) {
      e.preventDefault()
      toggle(id, false)
    } else if (!onObject) go(obj.querySelector<HTMLElement>('.dtree-name'))
  }
}

export function HistoryTree() {
  const plate = useApp((s) => s.plate)
  // A step being edited rolls its object back; when the object did not exist yet it leaves the plate, so the tree keeps it.
  const editing = useApp((s) => s.historyEdit)
  const selection = useApp((s) => s.selection)
  const selected = useApp((s) => s.selectedIds)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const ref = useRef<HTMLUListElement>(null)
  const objects: PlateEntry[] = editing && !plate.some((p) => p.id === editing.objectId) ? [...plate, editing.original] : plate

  // Roving focus: the focused row, or else the selected object, or else the first row, is the one Tab reaches.
  useLayoutEffect(() => {
    const tree = ref.current
    if (!tree) return
    const list = rows(tree)
    const current = list.find((el) => el === document.activeElement) ?? list.find((el) => el.getAttribute('aria-pressed') === 'true') ?? list[0]
    for (const el of tree.querySelectorAll<HTMLElement>(ROW)) el.tabIndex = el === current ? 0 : -1
  })

  if (!objects.length) return <p className="dtree-empty sx-small sx-muted">Add a model or a shape to start.</p>
  return (
    <ul
      ref={ref}
      className="dtree"
      role="tree"
      aria-label="Objects and their steps"
      onFocus={(e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>(ROW)
        if (row) for (const el of e.currentTarget.querySelectorAll<HTMLElement>(ROW)) el.tabIndex = el === row ? 0 : -1
      }}
      onKeyDown={(e) => treeKey(e.currentTarget, e, (id, o) => setOpen((s) => ({ ...s, [id]: o })))}
    >
      {objects.map((p) => {
        const steps = (editing?.objectId === p.id ? editing.original : p).history?.steps.length ?? 0
        const isOpen = open[p.id] ?? (p.id === selection || p.id === editing?.objectId)
        const isSel = p.id === selection || selected.includes(p.id)
        const kind = p.history ? 'body' : 'mesh'
        return (
          <li key={p.id} className="dtree-obj" role="treeitem" aria-level={1} aria-expanded={isOpen} aria-selected={isSel} aria-label={p.name} data-open={isOpen || undefined} data-object-id={p.id} data-testid="model-tree-object" data-kind={kind}>
            <ObjectRow entry={p} kind={kind} steps={steps} isOpen={isOpen} isSel={isSel} setOpen={(o) => setOpen((m) => ({ ...m, [p.id]: o }))} />
            {isOpen ? (
              <div className="dtree-body" role="group">
                {steps ? <HistorySteps objectId={p.id} tree /> : null}
                <ul className="dtree-parts" role="group" aria-label={`Parts of ${p.name}`}>
                  {p.handle.parts.map((part, i) => (
                    <li key={`${part.name}-${i}`} role="treeitem" aria-level={2} aria-label={part.name}>
                      <button type="button" className="dtree-part" data-tree-row="" tabIndex={-1} onClick={() => selectObject(p.id, false)}>
                        <Icon name="part" size={16} />
                        <span className="min0">{part.name}</span>
                      </button>
                    </li>
                  ))}
                  {(p.volumes ?? []).map((v) => (
                    <li key={v.id} role="treeitem" aria-level={2} aria-label={v.name}>
                      <button type="button" className="dtree-part" data-tree-row="" tabIndex={-1} onClick={() => selectObject(p.id, false)}>
                        <Icon name="modifier" size={16} />
                        <span className="min0">{v.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/** An object's row: its name selects it, a double click or F2 renames it, and a right click, a long press or Shift+F10 opens its menu. */
function ObjectRow({ entry: p, kind, steps, isOpen, isSel, setOpen }: { entry: PlateEntry; kind: 'body' | 'mesh'; steps: number; isOpen: boolean; isSel: boolean; setOpen: (open: boolean) => void }) {
  const nameRef = useRef<HTMLButtonElement>(null)
  const [renaming, setRenaming] = useState(false)
  // The menu acts on the selection, so a right click on an object outside it selects that object first.
  const pick = () => {
    if (!get().selectedIds.includes(p.id)) selectObject(p.id, false)
  }
  const menu = useContextMenu()
  const open = (point: { x: number; y: number }) => {
    pick()
    if (nameRef.current) menu.show(nameRef.current, point)
  }
  return (
    <div
      className="dtree-row"
      data-selected={isSel || undefined}
      {...menu.bind}
      onContextMenu={(e) => {
        e.preventDefault()
        open({ x: e.clientX, y: e.clientY })
      }}
      onKeyDown={(e) => {
        if (renaming) return
        if (e.key === 'F2') {
          e.preventDefault()
          setRenaming(true)
        } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
          e.preventDefault()
          const r = nameRef.current?.getBoundingClientRect()
          open({ x: (r?.left ?? 0) + 24, y: r?.bottom ?? 0 })
        }
      }}
    >
      <button type="button" className="dtree-chev" tabIndex={-1} aria-hidden="true" onClick={() => setOpen(!isOpen)}>
        <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={14} />
      </button>
      {renaming ? (
        <NameField
          value={p.name}
          label={`Name of ${p.name}`}
          onDone={(name) => {
            setRenaming(false)
            if (name !== null && name.trim()) renameObject(p.id, name)
            requestAnimationFrame(() => nameRef.current?.focus())
          }}
        />
      ) : (
        <button
          ref={nameRef}
          type="button"
          className="dtree-name"
          data-tree-row=""
          aria-pressed={isSel}
          onClick={(e) => {
            const additive = e.metaKey || e.ctrlKey || e.shiftKey
            selectObject(p.id, additive)
            if (!additive) setOpen(true)
          }}
          onDoubleClick={(e) => {
            e.preventDefault()
            setRenaming(true)
          }}
        >
          <Icon name={kind === 'body' ? 'body' : 'mesh-object'} size={16} />
          <span className="min0">{p.name}</span>
          {p.locked ? <Icon name="lock" size={14} className="dtree-state" label="Locked" /> : null}
          {p.printable === false ? <Icon name="hide" size={14} className="dtree-state" label="Not printed" /> : null}
        </button>
      )}
      {steps ? <span className="dtree-count sx-mono" aria-label={steps === 1 ? '1 step' : `${steps} steps`}>{steps}</span> : null}
      <ObjectMenu at={menu.at} onClose={menu.close} entry={p} onRename={() => setRenaming(true)} />
    </div>
  )
}

/** The inline name field: Enter or leaving it saves, Escape keeps the old name. */
function NameField({ value, label, onDone }: { value: string; label: string; onDone: (name: string | null) => void }) {
  const [text, setText] = useState(value)
  const done = useRef(false)
  const finish = (t: string | null) => {
    if (done.current) return
    done.current = true
    onDone(t)
  }
  return (
    <input
      className="sx-input dtree-rename"
      data-size="sm"
      data-testid="model-tree-rename"
      aria-label={label}
      value={text}
      maxLength={MAX_NAME}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(text)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(text)
        else if (e.key === 'Escape') finish(null)
      }}
    />
  )
}
