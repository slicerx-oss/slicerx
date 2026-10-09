// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The selected object's CAD history (docs/cad-history.md): one flat list of what was done to it. A
// step opens in its own tool with the object rolled back to before it, or, for a step with one
// number and no tool, changes that number in place. A step's number shows the part as it was right
// after it. Each step can move earlier or later, be suppressed or deleted; a broken step says why.
// Loads with the CAD tools, only for an object that has a history.
import { Button, Icon } from '@slicerx/ui'
import { Fragment, useRef, useState } from 'react'
import { useHost } from '../../host'
import { toast, useApp } from '../../state/store'
import { num } from '../panel-kit'
import { currentValues } from '../value-table'
import { bindFor } from '../values'
import { mainNumber, withNumber } from './model'
import { beginEdit, cancelEdit, deleteStep, renameStep, moveStep, setParams, setSuppressed, toolFor, viewStep } from './ops'
import { StepRow } from './step-row'
import '../cad.css'

const text = (e: unknown) => (e instanceof Error ? e.message : String(e))
const quiet = (e: unknown) => (e as { name?: string }).name === 'AbortError'

export function HistoryPanel({ objectId }: { objectId: string }) {
  const entry = useApp((s) => (s.historyEdit?.objectId === objectId ? s.historyEdit.original : s.plate.find((p) => p.id === objectId)))
  const h = entry?.history
  if (!entry || !h || (!h.steps.length && !h.ended)) return null
  return (
    <section className="cad-history" aria-label={`History of ${entry.name}`}>
      <header className="cad-history-h">
        <Icon name="history" size={14} />
        <span>History</span>
        <span className="sx-muted">{h.steps.length === 1 ? '1 step' : `${h.steps.length} steps`}</span>
      </header>
      <HistorySteps objectId={objectId} />
    </section>
  )
}

/** An object's steps, each with view, edit, move, suppress and delete. The Design tree shows them with icons and sketch rows. */
/**
 * The tree's rollback row: a thin bar after the step the part is shown at. Drag it to another step, or with focus
 * use Up and Down to move it a step and End to go back to the latest. The tree hides it at the latest.
 */
function RollbackRow({ index, count, onTo }: { index: number; count: number; onTo: (to: number) => void }) {
  const at = useRef(index)
  at.current = index
  const go = (to: number) => {
    const t = Math.max(0, Math.min(count - 1, to))
    if (t !== at.current) onTo(t)
  }
  return (
    <li
      className="cad-rollback"
      data-testid="model-tree-rollback"
      role="slider"
      tabIndex={0}
      aria-label="History position"
      aria-valuemin={1}
      aria-valuemax={count}
      aria-valuenow={index + 1}
      aria-valuetext={`After step ${index + 1} of ${count}`}
      data-tip-title="History position"
      data-tip-body="Drag, or use the arrow keys, to see the part at any step."
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') go(index - 1)
        else if (e.key === 'ArrowDown') go(index + 1)
        else if (e.key === 'End') onTo(count - 1)
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
      onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        // The step row under the pointer, from its index; above the first row is step 1.
        const row = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el instanceof HTMLElement && el.dataset['index'] !== undefined && el.dataset['testid'] === 'model-tree-step') as HTMLElement | undefined
        if (row) go(Number(row.dataset['index']))
      }}
    />
  )
}

export function HistorySteps({ objectId, tree, only }: { objectId: string; tree?: boolean; only?: ReadonlySet<number> | null }) {
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
    <>
      {h.ended ? <p className="cad-hint"><Icon name="info" size={14} /> {h.ended}</p> : null}
      <ol className="cad-steps" role={tree ? 'group' : undefined}>
        {h.steps.map((s, i) => (only && !only.has(i) ? null : (
          <Fragment key={s.id}>
          <StepRow
            key={s.id}
            step={s}
            tree={tree}
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
            onRename={(label) => {
              try {
                renameStep(objectId, i, label)
                return null
              } catch (e) {
                toast(text(e), 'warn')
                return text(e)
              }
            }}
            onEnd={cancelEdit}
            rolledBack={viewingIndex !== null}
            onNumber={(text) => {
              const v = num(text)
              if (!Number.isFinite(v)) return 'That is not a number, or a sum of named values that works out.'
              const next = withNumber(s.params, v)
              if (typeof next === 'string') return next
              const bind = bindFor(text, mainNumber(next)?.value ?? v, currentValues())
              if (v === mainNumber(s.params)?.value && bind === s.bind) return null
              void run(i, () => setParams(host.slicer, objectId, i, next, bind))
              return null
            }}
          />
          {tree && viewingIndex === i ? (
            <RollbackRow
              index={i}
              count={h.steps.length}
              onTo={(to) => void run(to, () => (to >= h.steps.length - 1 ? Promise.resolve(cancelEdit()) : viewStep(host.slicer, objectId, to)))}
            />
          ) : null}
          </Fragment>
        )))}
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
    </>
  )
}
