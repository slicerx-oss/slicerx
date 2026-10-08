// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One history step as a row: its number shows the part after it, its name edits it, and buttons move,
// suppress or delete it. Shared by the history list in Slice and the Design tree, which adds the step's
// icon and, under a sketch extrude or revolve, the sketch as a sub-row (the history itself is unchanged).
import { Button, Icon } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import type { PlateEntry } from '../../state/store'
import { mainNumber, stepName, type Step } from './model'
import { toolFor } from './ops'
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
  /** The Design tree: the step's icon before its name, and its sketch as a sub-row. */
  tree?: boolean | undefined
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
  return (
    <li className="cad-step" data-state={state} data-editing={editing || props.viewing || undefined} data-later={props.later || undefined} aria-busy={busy || undefined}>
      <button
        type="button"
        className="cad-step-n sx-mono"
        data-tip="history.view"
        {...tipAt}
        aria-label={props.viewing ? 'Back to the latest' : props.last ? `${name}: the part as it is now` : `Show the part after ${name}`}
        aria-pressed={props.viewing}
        disabled={busy}
        onClick={props.onView}
      >
        {index + 1}
      </button>
      <button
        type="button"
        className="cad-step-name"
        data-tip="history.edit"
        {...tipAt}
        aria-label={tool ? `Edit ${name}` : number ? `Change ${name}` : name}
        disabled={!tool && !number}
        onClick={tool ? props.onEdit : props.onOpen}
      >
        {props.tree ? <Icon name={stepIcon(s.params)} size={14} /> : null}
        {name}
      </button>
      <Button size="sm" variant="ghost" icon="arrow-up" data-tip="history.earlier" {...tipAt} aria-label={`Move ${name} earlier`} disabled={busy || index === 0} onClick={() => props.onMove(index - 1)} />
      <Button size="sm" variant="ghost" icon="arrow-down" data-tip="history.later" {...tipAt} aria-label={`Move ${name} later`} disabled={busy || props.last} onClick={() => props.onMove(index + 1)} />
      <Button size="sm" variant="ghost" icon={s.suppressed ? 'hide' : 'show'} data-tip="history.suppress" {...tipAt} aria-label={s.suppressed ? `Turn ${name} back on` : `Suppress ${name}`} pressed={Boolean(s.suppressed)} disabled={busy} onClick={props.onSuppress} />
      <Button size="sm" variant="ghost" icon="delete" data-tip="history.delete" {...tipAt} aria-label={`Delete ${name}`} disabled={busy} onClick={props.onDelete} />
      {state === 'broken' ? <p className="cad-step-why"><Icon name="alert" size={13} /> {s.broken}</p> : state === 'skipped' ? <p className="cad-step-why sx-muted">Skipped: a step before it is broken.</p> : null}
      {state === 'done' && s.note ? <p className="cad-step-why sx-muted" data-testid="step-note"><Icon name="info" size={13} /> {s.note}</p> : null}
      {s.bind !== undefined ? <p className="cad-step-why sx-muted" data-testid="step-bind">Follows {s.bind}</p> : null}
      {props.tree && sketch ? (
        <p className="cad-step-sketch" data-testid="step-sketch">
          <Icon name="ruler" size={13} />
          <span>Sketch</span>
          <span className="sx-mono sx-muted">{sketch.loops === 1 ? '1 loop' : `${sketch.loops} loops`}</span>
        </p>
      ) : null}
      {props.open && number ? <NumberEdit label={number.label} unit={number.unit} value={s.bind ?? String(number.value)} onApply={props.onNumber} /> : null}
    </li>
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
