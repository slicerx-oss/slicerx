// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The selected object's CAD history (docs/cad-history.md): one flat list of what was done to it. A
// step opens in its own tool with the object rolled back to before it, or, for a step with one
// number and no tool, changes that number in place. A step's number shows the part as it was right
// after it. Each step can move earlier or later, be suppressed or deleted; a broken step says why.
// Loads with the CAD tools, only for an object that has a history.
import { Button, Icon } from '@slicerx/ui'
import { useEffect, useState } from 'react'
import { useHost } from '../../host'
import { toast, useApp, type PlateEntry } from '../../state/store'
import { mainNumber, stepName, withNumber, type Step } from './model'
import { beginEdit, cancelEdit, deleteStep, moveStep, setParams, setSuppressed, toolFor, viewStep } from './ops'
import '../cad.css'

const text = (e: unknown) => (e instanceof Error ? e.message : String(e))
const quiet = (e: unknown) => (e as { name?: string }).name === 'AbortError'

export function HistoryPanel({ objectId }: { objectId: string }) {
  const host = useHost()
  const entry = useApp((s) => (s.historyEdit?.objectId === objectId ? s.historyEdit.original : s.plate.find((p) => p.id === objectId)))
  const editingIndex = useApp((s) => (s.historyEdit?.objectId === objectId && !s.historyEdit.view ? s.historyEdit.index : null))
  const viewingIndex = useApp((s) => (s.historyEdit?.objectId === objectId && s.historyEdit.view ? s.historyEdit.index : null))
  const [busy, setBusy] = useState<number | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const h = entry?.history
  if (!entry || !h || (!h.steps.length && !h.ended)) return null

  const run = async (i: number, fn: () => Promise<unknown>) => {
    setBusy(i)
    try {
      await fn()
    } catch (e) {
      if (!quiet(e)) toast(text(e), 'warn')
    } finally {
      setBusy(null)
    }
  }
  const firstBroken = h.steps.findIndex((s) => s.broken !== undefined && !s.suppressed)
  return (
    <section className="cad-history" aria-label={`History of ${entry.name}`}>
      <header className="cad-history-h">
        <Icon name="history" size={14} />
        <span>History</span>
        <span className="sx-muted">{h.steps.length === 1 ? '1 step' : `${h.steps.length} steps`}</span>
      </header>
      {h.ended ? <p className="cad-hint"><Icon name="info" size={14} /> {h.ended}</p> : null}
      <ol className="cad-steps">
        {h.steps.map((s, i) => (
          <StepRow
            key={s.id}
            step={s}
            index={i}
            entry={entry}
            skipped={firstBroken >= 0 && i > firstBroken && !s.suppressed}
            busy={busy === i}
            editing={editingIndex === i}
            open={open === i}
            last={i === h.steps.length - 1}
            viewing={viewingIndex === i}
            later={viewingIndex !== null && i > viewingIndex}
            onView={() => void run(i, () => (viewingIndex === i || i === h.steps.length - 1 ? Promise.resolve(cancelEdit()) : viewStep(host.slicer, objectId, i)))}
            onMove={(to) => void run(i, () => moveStep(host.slicer, objectId, i, to))}
            onOpen={() => setOpen(open === i ? null : i)}
            onEdit={() => void run(i, () => (toolFor(s.params) ? beginEdit(host.slicer, objectId, i) : Promise.resolve(setOpen(i))))}
            onSuppress={() => void run(i, () => setSuppressed(host.slicer, objectId, i, !s.suppressed))}
            onDelete={() => void run(i, () => deleteStep(host.slicer, objectId, i))}
            onNumber={(v) => {
              const next = withNumber(s.params, v)
              if (typeof next === 'string') return next
              void run(i, () => setParams(host.slicer, objectId, i, next))
              return null
            }}
          />
        ))}
      </ol>
      {editingIndex !== null ? (
        <div className="cad-row">
          <span className="sx-small sx-muted">The part shows how it was before step {editingIndex + 1}.</span>
          <Button size="sm" variant="ghost" onClick={cancelEdit}>Stop editing</Button>
        </div>
      ) : viewingIndex !== null ? (
        <div className="cad-row">
          <span className="sx-small sx-muted">The part shows how it was after step {viewingIndex + 1}.</span>
          <Button size="sm" variant="ghost" onClick={cancelEdit}>Back to the latest</Button>
        </div>
      ) : null}
    </section>
  )
}

function StepRow(props: {
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
  onNumber: (v: number) => string | null
}) {
  const { step: s, index, skipped, busy, editing } = props
  const name = stepName(s)
  const number = mainNumber(s.params)
  const tool = toolFor(s.params)
  const state = s.suppressed ? 'suppressed' : s.broken !== undefined ? 'broken' : skipped ? 'skipped' : 'done'
  return (
    <li className="cad-step" data-state={state} data-editing={editing || props.viewing || undefined} data-later={props.later || undefined} aria-busy={busy || undefined}>
      <button
        type="button"
        className="cad-step-n sx-mono"
        data-tip="history.view"
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
        aria-label={tool ? `Edit ${name}` : number ? `Change ${name}` : name}
        disabled={!tool && !number}
        onClick={tool ? props.onEdit : props.onOpen}
      >
        {name}
      </button>
      <Button size="sm" variant="ghost" icon="arrow-up" data-tip="history.earlier" aria-label={`Move ${name} earlier`} disabled={busy || index === 0} onClick={() => props.onMove(index - 1)} />
      <Button size="sm" variant="ghost" icon="arrow-down" data-tip="history.later" aria-label={`Move ${name} later`} disabled={busy || props.last} onClick={() => props.onMove(index + 1)} />
      <Button size="sm" variant="ghost" icon={s.suppressed ? 'hide' : 'show'} data-tip="history.suppress" aria-label={s.suppressed ? `Turn ${name} back on` : `Suppress ${name}`} pressed={Boolean(s.suppressed)} disabled={busy} onClick={props.onSuppress} />
      <Button size="sm" variant="ghost" icon="delete" data-tip="history.delete" aria-label={`Delete ${name}`} disabled={busy} onClick={props.onDelete} />
      {state === 'broken' ? <p className="cad-step-why"><Icon name="alert" size={13} /> {s.broken}</p> : state === 'skipped' ? <p className="cad-step-why sx-muted">Skipped: a step before it is broken.</p> : null}
      {props.open && number ? <NumberEdit label={number.label} unit={number.unit} value={number.value} onApply={props.onNumber} /> : null}
    </li>
  )
}

/** One number, applied on Enter or when the field is left. */
function NumberEdit({ label, unit, value, onApply }: { label: string; unit: string; value: number; onApply: (v: number) => string | null }) {
  const [text, setText] = useState(String(value))
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => setText(String(value)), [value])
  const apply = () => {
    const v = Number(text.trim().replace(',', '.'))
    if (v === value) return
    setNote(onApply(v))
  }
  return (
    <div className="cad-step-edit">
      <label>
        <span className="sx-small sx-muted">{label}</span>
        <input className="sx-input" data-mono data-size="sm" inputMode="decimal" value={text} aria-label={`${label} in ${unit}`} onChange={(e) => setText(e.target.value)} onBlur={apply} onKeyDown={(e) => e.key === 'Enter' && apply()} />
        <span className="sx-small sx-muted">{unit}</span>
      </label>
      {note ? <p className="cad-note"><Icon name="alert" size={13} /> {note}</p> : null}
    </div>
  )
}
