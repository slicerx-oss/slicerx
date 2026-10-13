// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Design's timeline: every sketch and feature of the design in the order made, across all bodies, the way Fusion's
// timeline runs (docs/cad-history.md, "Timeline"). The marker rolls the whole design back (cad/history/rollback.ts).
// A click on a feature picks its body, a double click opens the step's tool, and dragging a feature moves it among
// its body's steps. Every action is an existing history operation (cad/history/ops.ts).
import { Button, Icon } from '@slicerx/ui'
import { useRef, useState } from 'react'
import { featureParams, mainNumber, stepName, type FeatureItem, type SketchItem, type Step } from '@slicerx/cad-history'
import { beginEdit, cancelEdit, moveStep, toolFor } from '../../cad/history/ops'
import { stepIcon } from '../../cad/history/step-icon'
import { useHost } from '../../host'
import { useMadeBy } from './use-made-by'
import { useBottomPanel } from '../../shell/bottom-panel'
import { set, toast, useApp } from '../../state/store'
import { DEFAULT_UNITS, formatLength, lengthText, type UnitPrefs } from '../../cad/units'
import { useLengthWords } from '../../cad/use-units'

/** A chip's short name: the step's name up to its first comma, without units, with its main number ("Shell 2", "Fillet 5"). */
export function chipName(s: Pick<Step, 'params'>, units: UnitPrefs = DEFAULT_UNITS): string {
  const base = stepName(s, (mm) => lengthText(mm, units)).split(',')[0]!.replace(/ (mm|in)\b/g, '').trim()
  const n = mainNumber(s.params)
  return /\d/.test(base) || !n ? base : `${base} ${n.unit === 'mm' ? formatLength(n.value, units) : Math.round(n.value * 100) / 100}`
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e))
const quiet = (e: unknown) => (e as { name?: string }).name === 'AbortError'
const LATER = 'Rolled back: move the marker past it to use it.'

/** One chip: a sketch, or a feature with its params whole and its place among its body's live steps. */
type Chip = { kind: 'sketch'; item: SketchItem } | { kind: 'feature'; item: FeatureItem; step: Step | null; index: number | null }

export function Timeline() {
  const host = useHost()
  const panel = useBottomPanel()
  const units = useApp((s) => s.units)
  const words = useLengthWords()
  const t = useApp((s) => s.timeline)
  const edit = useApp((s) => s.historyEdit)
  const selection = useApp((s) => s.selection)
  const plate = useApp((s) => s.plate)
  const held = useApp((s) => s.rollback?.ends)
  const [busy, setBusy] = useState(false)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const track = useRef<HTMLOListElement>(null)
  const made = useMadeBy()

  if (!t.items.length) return <p className="tl-empty sx-small sx-muted">No sketches or steps yet. What you draw and the tools you use add them here.</p>

  const names = new Map([...(held ?? []).map((h) => h.entry), ...plate].map((e) => [e.id, e.name]))
  const sketches = new Map(t.items.filter((i): i is SketchItem => i.kind === 'sketch').map((k) => [k.id, k]))
  const seen = new Map<string, number>()
  const chips: Chip[] = t.items.map((item, i) => {
    if (item.kind === 'sketch') return { kind: 'sketch', item }
    const params = featureParams(item, sketches)
    const { kind: _k, body: _b, ...rest } = item
    const step = params ? ({ ...rest, params } as Step) : null
    if (i >= t.marker) return { kind: 'feature', item, step, index: null }
    const n = seen.get(item.body) ?? 0
    seen.set(item.body, n + 1)
    return { kind: 'feature', item, step, index: n }
  })
  const end = t.items.length
  const at = Math.min(t.marker, end)

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
  const roll = (to: number) => {
    if (to === at || to < 0 || to > end) return
    void run(() => import('../../cad/history/rollback').then((m) => m.rollTo(host.slicer, to)))
  }
  const open = (c: Chip) => {
    if (c.kind !== 'feature' || c.index === null || !c.step || !toolFor(c.step.params)) return
    const index = c.index
    void run(() => beginEdit(host.slicer, c.item.body, index))
  }
  // The marker spot under the pointer: before the first chip whose middle is right of it.
  const spotAt = (x: number): number => {
    const els = [...(track.current?.querySelectorAll<HTMLElement>('.tl-chip') ?? [])]
    for (let i = 0; i < els.length; i++) {
      const r = els[i]!.getBoundingClientRect()
      if (x < r.left + r.width / 2) return i
    }
    return els.length
  }
  const editing = edit && !edit.view ? { body: edit.objectId, id: edit.original.history?.steps[edit.index]?.id } : null

  const marker = (
    <span
      className="tl-marker"
      role="slider"
      tabIndex={0}
      data-testid="tl-marker"
      aria-label="Roll the design back"
      aria-valuemin={0}
      aria-valuemax={end}
      aria-valuenow={at}
      aria-valuetext={at >= end ? 'At the end' : `After ${at} of ${end}`}
      onKeyDown={(e) => {
        const to = e.key === 'ArrowLeft' ? at - 1 : e.key === 'ArrowRight' ? at + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? end : null
        if (to === null) return
        e.preventDefault()
        roll(to)
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        panel.drag(true)
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId)
        panel.drag(false)
        roll(spotAt(e.clientX))
      }}
    />
  )

  return (
    <div className="tl" aria-busy={busy || undefined}>
      <div className="tl-nav">
        <Button size="sm" variant="ghost" icon="chevron-left" aria-label="Roll back one" disabled={busy || at <= 0} onClick={() => roll(at - 1)} />
        <Button size="sm" variant="ghost" icon="chevron-right" aria-label="Roll forward one" disabled={busy || at >= end} onClick={() => roll(at + 1)} />
      </div>
      <ol ref={track} className="tl-track" aria-label="Design timeline">
        {at === 0 ? <li className="tl-item">{marker}</li> : null}
        {chips.map((c, i) => {
          const later = i >= at
          if (c.kind === 'sketch') {
            const k = c.item
            const loops = k.loops.length === 1 ? '1 loop' : `${k.loops.length} loops`
            return (
              <li key={k.id} className="tl-item">
                <button type="button" className="tl-chip" data-kind="sketch" data-later={later || undefined} aria-label={`${i + 1}, ${k.name}`} data-tip-title={k.name} data-tip-body={later ? LATER : loops} disabled={busy}>
                  <span className="tl-n sx-mono">{i + 1}</span>
                  <Icon name="sketch" size={14} />
                  <span className="tl-name">{k.name}</span>
                </button>
                {i === at - 1 ? marker : null}
              </li>
            )
          }
          const f = c.item
          const s = c.step
          const name = s ? stepName(s, words) : 'A step whose sketch is gone'
          const body = names.get(f.body) ?? 'a body'
          const state = f.suppressed ? 'suppressed' : f.broken !== undefined || !s ? 'broken' : 'done'
          const mine = made?.objectId === f.body && c.index !== null
          return (
            <li key={`${f.body}:${f.id}`} className="tl-item" data-drop={dropAt === i || undefined}>
              <button
                type="button"
                className="tl-chip"
                data-kind="feature"
                data-state={state}
                data-own={f.body === selection || undefined}
                data-current={(editing?.body === f.body && editing.id === f.id) || undefined}
                data-later={later || undefined}
                data-made-by={(mine && made.index === c.index) || undefined}
                data-used-by={(mine && made.index !== c.index && made.used.includes(c.index!)) || undefined}
                draggable={!busy && !later}
                aria-label={`${i + 1}, ${name}, on ${body}`}
                data-tip-title={`${name} (${body})`}
                data-tip-body={later ? LATER : (f.broken ?? 'Click to pick its body, double-click to edit it, drag to move it among its body’s steps.')}
                disabled={busy}
                onClick={() => {
                  if (!later && edit === null) set({ selection: f.body, selectedIds: [f.body] })
                }}
                onDoubleClick={() => open(c)}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', String(i))
                  setDragFrom(i)
                  panel.drag(true)
                }}
                onDragOver={(e) => {
                  const from = dragFrom === null ? null : chips[dragFrom]
                  // a step moves among its own body's steps
                  if (from?.kind !== 'feature' || from.item.body !== f.body || c.index === null) return
                  e.preventDefault()
                  setDropAt(i)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const from = dragFrom === null ? null : chips[dragFrom]
                  setDragFrom(null)
                  setDropAt(null)
                  if (from?.kind !== 'feature' || from.item.body !== f.body || from.index === null || c.index === null || from.index === c.index) return
                  const a = from.index
                  const b = c.index
                  void run(() => moveStep(host.slicer, f.body, a, b))
                }}
                onDragEnd={() => {
                  setDragFrom(null)
                  setDropAt(null)
                  panel.drag(false)
                }}
              >
                <span className="tl-n sx-mono">{i + 1}</span>
                <Icon name={s ? stepIcon(s.params) : 'warning'} size={14} />
                <span className="tl-name">{s ? chipName(s, units) : name}</span>
                {f.sketch ? (
                  <span className="tl-sketch">
                    <Icon name="sketch" size={11} />
                    {sketches.get(f.sketch)?.name ?? ''}
                  </span>
                ) : null}
              </button>
              {i === at - 1 ? marker : null}
            </li>
          )
        })}
      </ol>
      <div className="tl-status sx-small">
        {editing ? (
          <>
            <span className="sx-muted">Editing a step of {names.get(editing.body) ?? 'a body'}</span>
            <button type="button" className="sx-linkbtn" onClick={() => cancelEdit()}>
              Stop editing
            </button>
          </>
        ) : at < end ? (
          <>
            <span className="sx-muted" data-testid="tl-rolled">
              Rolled back to {at} of {end}
            </span>
            <button type="button" className="sx-linkbtn" disabled={busy} onClick={() => roll(end)}>
              Move to the end
            </button>
          </>
        ) : (
          <span className="sx-muted">{end === 1 ? '1 item' : `${end} items`}</span>
        )}
      </div>
    </div>
  )
}
