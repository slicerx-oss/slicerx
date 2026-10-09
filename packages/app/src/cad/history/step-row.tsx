// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One history step as a row: its number shows the part after it, its name edits it, and buttons move,
// suppress or delete it. Shared by the history list in Slice and the Model tree. The tree's row is calmer: the
// step's icon before its name, the move, suppress and delete actions in one More menu in a slot of its own at the
// row's end, and under a sketch extrude or revolve the sketch as a sub-row that opens it (the history is unchanged).
import { Button, Icon, useContextMenu } from '@slicerx/ui'
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { PlateEntry } from '../../state/store'
import { mainNumber, stepName, type Step } from './model'
import { toolFor } from './ops'
import { DeleteStepDialog, StepMenu } from './step-menu'
import { stepIcon, stepSketch } from './step-icon'

export function StepRow(props: {
  step: Step
  index: number
  entry: PlateEntry
  skipped: boolean
  busy: boolean
  editing: boolean
  open: boolean
  last: boolean
  viewing: boolean
  later: boolean
  onView: () => void
  onMove: (to: number) => void
  onOpen: () => void
  onEdit: () => void
  onSuppress: () => void
  onDelete: () => void
  onNumber: (text: string) => string | null
  /** The Model tree: the step's icon before its name, a More menu, and its sketch as a sub-row. */
  tree?: boolean | undefined
  /** The tree's rename: the new name, or "" for the step's own. A sentence when it is refused. */
  onRename?: ((label: string) => string | null) | undefined
  /** The tree's way back to the latest while the part is rolled back. */
  onEnd?: (() => void) | undefined
  /** The part is rolled back to some step of this object. */
  rolledBack?: boolean | undefined
}) {
  const { step: s, index, skipped, busy, editing } = props
  const name = stepName(s)
  const number = mainNumber(s.params)
  const tool = toolFor(s.params)
  const sketch = props.tree ? stepSketch(s.params) : null
  const state = s.suppressed ? 'suppressed' : s.broken !== undefined ? 'broken' : skipped ? 'skipped' : 'done'
  // The tree is a narrow column of short rows, and a tip under a button there covers the next step and its buttons
  // (and stays while the pointer rests on the button). Its tips sit beside the whole row instead.
  const tipAt = props.tree ? { 'data-tip-avoid': '.cad-step' } : {}
  // In the tree the arrow keys move between rows (history-tree.tsx), so only a row's name is in the tab order.
  const tab = props.tree ? { tabIndex: -1 } : {}
  const menu = useContextMenu()
  const [renaming, setRenaming] = useState(false)
  const [confirm, setConfirm] = useState(false)
  // F2 renames and Alt+Up and Alt+Down move, as the menu says; Shift+F10 and the menu key open it.
  const keys = (e: KeyboardEvent<HTMLElement>) => {
    if (renaming) return
    if (e.key === 'F2') {
      e.preventDefault()
      setRenaming(true)
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      e.stopPropagation()
      const to = index + (e.key === 'ArrowUp' ? -1 : 1)
      if (!busy && to >= 0 && !(e.key === 'ArrowDown' && props.last)) props.onMove(to)
    } else menu.bind.onKeyDown(e)
  }
  const treeRow = props.tree
    ? { ...menu.bind, onKeyDown: keys, tabIndex: -1, role: 'treeitem', 'aria-level': 2, 'aria-label': name, 'data-testid': 'model-tree-step', 'data-object-id': props.entry.id, 'data-index': index, 'data-state': state }
    : {}
  return (
    <li className="cad-step" data-state={state} data-editing={editing || props.viewing || undefined} data-later={props.later || undefined} aria-busy={busy || undefined} {...treeRow}>
      <button
        type="button"
        className="cad-step-n sx-mono"
        data-tip="history.view"
        {...tipAt}
        aria-label={props.viewing ? 'Back to the latest' : props.last ? `${name}: the part as it is now` : `Show the part after ${name}`}
        aria-pressed={props.viewing}
        disabled={busy}
        {...tab}
        onClick={props.onView}
      >
        {index + 1}
      </button>
      {renaming ? (
        <RenameField
          value={s.label ?? name}
          label={`Name of step ${index + 1}`}
          onDone={(text) => {
            setRenaming(false)
            if (text !== null) props.onRename?.(text)
          }}
        />
      ) : (
      <button
        type="button"
        className="cad-step-name"
        data-tip="history.edit"
        {...tipAt}
        aria-label={tool ? `Edit ${name}` : number ? `Change ${name}` : name}
        disabled={!tool && !number}
        {...(props.tree ? { 'data-tree-row': '' } : {})}
        onClick={tool ? props.onEdit : props.onOpen}
        {...(props.tree ? { onDoubleClick: (e: MouseEvent) => (e.preventDefault(), setRenaming(true)) } : {})}
      >
        {props.tree ? (
          <span className="cad-step-icon" data-badge={state === 'broken' ? 'broken' : state === 'done' && s.note ? 'note' : undefined}>
            <Icon name={stepIcon(s.params)} size={16} />
          </span>
        ) : null}
        <span className="cad-step-label">{name}</span>
      </button>
      )}
      {props.tree ? (
        <span className="cad-step-more">
          <button
            type="button"
            className="cad-step-more-btn"
            data-testid="model-tree-more"
            data-tip-title="More"
            data-tip-avoid=".cad-step"
            aria-label={`More for ${name}`}
            aria-haspopup="menu"
            aria-expanded={menu.at !== null}
            tabIndex={-1}
            disabled={busy}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              menu.show(e.currentTarget, { x: r.right - 200, y: r.bottom + 4 })
            }}
          >
            <Icon name="more" size={16} />
          </button>
          <StepMenu
            at={menu.at}
            onClose={menu.close}
            name={name}
            index={index}
            last={props.last}
            suppressed={Boolean(s.suppressed)}
            editable={tool !== null}
            rolledBack={Boolean(props.rolledBack)}
            viewing={props.viewing}
            hasSketch={sketch !== null}
            onEdit={props.onEdit}
            onView={props.onView}
            onEnd={() => props.onEnd?.()}
            onSuppress={props.onSuppress}
            onMove={props.onMove}
            onRename={() => setRenaming(true)}
            onDelete={() => setConfirm(true)}
          />
          {confirm ? <DeleteStepDialog name={name} open onCancel={() => setConfirm(false)} onDelete={() => (setConfirm(false), props.onDelete())} /> : null}
        </span>
      ) : (
        <>
          <Button size="sm" variant="ghost" icon="arrow-up" data-tip="history.earlier" aria-label={`Move ${name} earlier`} disabled={busy || index === 0} onClick={() => props.onMove(index - 1)} />
          <Button size="sm" variant="ghost" icon="arrow-down" data-tip="history.later" aria-label={`Move ${name} later`} disabled={busy || props.last} onClick={() => props.onMove(index + 1)} />
          <Button size="sm" variant="ghost" icon={s.suppressed ? 'hide' : 'show'} data-tip="history.suppress" aria-label={s.suppressed ? `Turn ${name} back on` : `Suppress ${name}`} pressed={Boolean(s.suppressed)} disabled={busy} onClick={props.onSuppress} />
          <Button size="sm" variant="ghost" icon="delete" data-tip="history.delete" aria-label={`Delete ${name}`} disabled={busy} onClick={props.onDelete} />
        </>
      )}
      {state === 'broken' ? <p className="cad-step-why"><Icon name="alert" size={13} /> {s.broken}</p> : state === 'skipped' ? <p className="cad-step-why sx-muted">Skipped: a step before it is broken.</p> : null}
      {state === 'done' && s.note ? <p className="cad-step-why sx-muted" data-testid="step-note"><Icon name="info" size={13} /> {s.note}</p> : null}
      {s.bind !== undefined ? <p className="cad-step-why sx-muted" data-testid="step-bind">Follows {s.bind}</p> : null}
      {props.tree && sketch ? (
        <button type="button" className="cad-step-sketch" data-testid="step-sketch" aria-label={`Open the sketch of ${name}`} disabled={busy || !tool} {...tab} onClick={props.onEdit}>
          <Icon name="ruler" size={14} />
          <span>Sketch</span>
          <span className="sx-mono sx-muted">{sketch.loops === 1 ? '1 loop' : `${sketch.loops} loops`}</span>
        </button>
      ) : null}
      {props.open && number ? <NumberEdit label={number.label} unit={number.unit} value={s.bind ?? String(number.value)} onApply={props.onNumber} /> : null}
    </li>
  )
}

/** The inline name field: Enter or leaving it saves, Escape keeps the old name. Empty gives the step its own name back. */
function RenameField({ value, label, onDone }: { value: string; label: string; onDone: (text: string | null) => void }) {
  const [text, setText] = useState(value)
  const done = useRef(false)
  const finish = (t: string | null) => {
    if (done.current) return
    done.current = true
    onDone(t)
  }
  return (
    <input
      className="sx-input cad-step-rename"
      data-size="sm"
      data-testid="model-tree-rename"
      aria-label={label}
      value={text}
      maxLength={100}
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

/** One number, or a sum of named values the step then follows, applied on Enter or when the field is left. */
function NumberEdit({ label, unit, value, onApply }: { label: string; unit: string; value: string; onApply: (text: string) => string | null }) {
  const [text, setText] = useState(value)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => setText(value), [value])
  const apply = () => {
    if (text.trim() === value) return
    setNote(onApply(text))
  }
  return (
    <div className="cad-step-edit">
      <label>
        <span className="sx-small sx-muted">{label}</span>
        <input className="sx-input" data-mono data-size="sm" value={text} aria-label={`${label} in ${unit}`} onChange={(e) => setText(e.target.value)} onBlur={apply} onKeyDown={(e) => e.key === 'Enter' && apply()} />
        <span className="sx-small sx-muted">{unit}</span>
      </label>
      {note ? <p className="cad-note"><Icon name="alert" size={13} /> {note}</p> : null}
    </div>
  )
}
