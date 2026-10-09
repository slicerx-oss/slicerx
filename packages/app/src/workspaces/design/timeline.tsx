// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Design's timeline: the selected object's history as a row of chips, with a sketch shown under its extrude. A click
// shows the part right after that step, a double click opens the step's tool to edit it, dragging a chip moves the step
// and dragging the marker steps through the history. Every action is an existing history operation (cad/history/ops.ts).
import { Button, Icon } from '@slicerx/ui'
import { useRef, useState } from 'react'
import { mainNumber, stepName, type Step } from '../../cad/history/model'
import { beginEdit, cancelEdit, moveStep, toolFor, viewStep } from '../../cad/history/ops'
import { stepIcon, stepSketch } from '../../cad/history/step-icon'
import { useHost } from '../../host'
import { useMadeBy } from './use-made-by'
import { useBottomPanel } from '../../shell/bottom-panel'
import { toast, useApp } from '../../state/store'

/** A chip's short name: the step's name up to its first comma, without units, with its main number ("Shell 2", "Fillet 5"). */
export function chipName(s: Pick<Step, 'params'>): string {
  const base = stepName(s).split(',')[0]!.replace(/ mm\b/g, '').trim()
  const n = mainNumber(s.params)
  return /\d/.test(base) || !n ? base : `${base} ${Math.round(n.value * 100) / 100}`
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e))
const quiet = (e: unknown) => (e as { name?: string }).name === 'AbortError'

export function Timeline() {
  const host = useHost()
  const panel = useBottomPanel()
  const edit = useApp((s) => s.historyEdit)
  const objectId = useApp((s) => s.historyEdit?.objectId ?? s.selection)
  const entry = useApp((s) => (s.historyEdit?.objectId === objectId ? s.historyEdit?.original : s.plate.find((p) => p.id === objectId)))
  const [busy, setBusy] = useState(false)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const track = useRef<HTMLOListElement>(null)
  const steps = entry?.history?.steps ?? []
  const made = useMadeBy()

  if (!entry) return <p className="tl-empty sx-small sx-muted">Select an object to see its steps.</p>
  if (!steps.length) return <p className="tl-empty sx-small sx-muted">{entry.name} has no steps yet. The tools you use on it add them here.</p>

  const id = entry.id
  const last = steps.length - 1
  const editing = edit?.objectId === id && !edit.view ? edit.index : null
  const viewing = edit?.objectId === id && edit.view ? edit.index : null
  // The marker sits after the step the part shows: the one viewed, the one before the edited step, or the last.
  const at = viewing ?? (editing !== null ? editing - 1 : last)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      if (!quiet(e)) toast(text(e), 'warn')
    } finally {
      setBusy(false)
    }
  }
  const show = (i: number) => void run(() => (i >= last ? Promise.resolve(cancelEdit()) : viewStep(host.slicer, id, i)))
  const open = (i: number) => (toolFor(steps[i]!.params) ? void run(() => beginEdit(host.slicer, id, i)) : show(i))
  // The chip under the pointer, for the marker drag.
  const chipAt = (x: number): number => {
    const chips = [...(track.current?.querySelectorAll<HTMLElement>('.tl-chip') ?? [])]
    let best = last
    for (let i = 0; i < chips.length; i++) {
      const r = chips[i]!.getBoundingClientRect()
      if (x < r.left + r.width / 2) return Math.max(0, i - 1)
      best = i
    }
    return best
  }

  return (
    <div className="tl" aria-busy={busy || undefined}>
      <div className="tl-nav">
        <Button size="sm" variant="ghost" icon="chevron-left" aria-label="Show the step before" disabled={busy || at <= 0} onClick={() => show(at - 1)} />
        <Button size="sm" variant="ghost" icon="chevron-right" aria-label="Show the step after" disabled={busy || at >= last} onClick={() => show(at + 1)} />
      </div>
      <ol ref={track} className="tl-track" aria-label={`Steps of ${entry.name}`}>
        {steps.map((s, i) => {
          const name = stepName(s)
          const sketch = stepSketch(s.params)
          const state = s.suppressed ? 'suppressed' : s.broken !== undefined ? 'broken' : 'done'
          return (
            <li key={s.id} className="tl-item" data-drop={dropAt === i || undefined}>
              <button
                type="button"
                className="tl-chip"
                data-state={state}
                data-current={editing === i || viewing === i || undefined}
                data-later={i > at || undefined}
                data-made-by={(made?.objectId === id && made.index === i) || undefined}
                data-used-by={(made?.objectId === id && made.index !== i && made.used.includes(i)) || undefined}
                draggable={!busy}
                aria-label={`Step ${i + 1}, ${name}`}
                data-tip-title={name}
                data-tip-body={s.broken ?? 'Click to show the part after it, double-click to edit it, drag to move it.'}
                disabled={busy}
                onClick={() => show(i)}
                onDoubleClick={() => open(i)}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', String(i))
                  setDragFrom(i)
                  panel.drag(true)
                }}
                onDragOver={(e) => {
                  if (dragFrom === null) return
                  e.preventDefault()
                  setDropAt(i)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const from = dragFrom
                  setDragFrom(null)
                  setDropAt(null)
                  if (from !== null && from !== i) void run(() => moveStep(host.slicer, id, from, i))
                }}
                onDragEnd={() => {
                  setDragFrom(null)
                  setDropAt(null)
                  panel.drag(false)
                }}
              >
                <span className="tl-n sx-mono">{i + 1}</span>
                <Icon name={stepIcon(s.params)} size={14} />
                <span className="tl-name">{chipName(s)}</span>
                {sketch ? <span className="tl-sketch"><Icon name="sketch" size={11} />{sketch.loops === 1 ? '1 loop' : `${sketch.loops} loops`}</span> : null}
              </button>
              {i === at ? (
                <span
                  className="tl-marker"
                  role="slider"
                  tabIndex={0}
                  aria-label="Show the part after a step"
                  aria-valuemin={1}
                  aria-valuemax={steps.length}
                  aria-valuenow={at + 1}
                  aria-valuetext={`After step ${at + 1}, ${stepName(steps[at]!)}`}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft' && at > 0) (e.preventDefault(), show(at - 1))
                    if (e.key === 'ArrowRight' && at < last) (e.preventDefault(), show(at + 1))
                  }}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId)
                    panel.drag(true)
                  }}
                  onPointerUp={(e) => {
                    e.currentTarget.releasePointerCapture(e.pointerId)
                    panel.drag(false)
                    const to = chipAt(e.clientX)
                    if (to !== at) show(to)
                  }}
                />
              ) : null}
            </li>
          )
        })}
      </ol>
      <div className="tl-status sx-small">
        {editing !== null ? (
          <>
            <span className="sx-muted">Editing step {editing + 1}</span>
            <button type="button" className="sx-linkbtn" onClick={() => cancelEdit()}>Back to the latest</button>
          </>
        ) : viewing !== null ? (
          <>
            <span className="sx-muted">Showing step {viewing + 1}</span>
            <button type="button" className="sx-linkbtn" onClick={() => cancelEdit()}>Back to the latest</button>
          </>
        ) : (
          <span className="sx-muted">{steps.length === 1 ? '1 step' : `${steps.length} steps`}</span>
        )}
      </div>
    </div>
  )
}
