// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slide to print: a track with a knob the person drags to its far end, where a ring waits. Letting go at the end starts
// the print; letting go short of it puts the knob back. The knob is a slider for the keyboard (arrow keys step it,
// End takes it to the end), and the ring at the end is a button for a person who can't drag. Nothing happens on a
// bare press of the knob. The track keeps its size in every state; only what is inside it changes.
import { Icon } from '@slicerx/ui'
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { SLIDE_NAME, SLIDE_TO_PRINT } from './send-words'

export type SlideState = 'off' | 'ready' | 'sending' | 'sent' | 'failed'

/** How far along the track (0 to 1) a release counts as reaching the end. */
export const SLIDE_DONE_AT = 0.85
/** One arrow key's step, in percent of the track. */
const STEP = 25

export interface SlideToPrintProps {
  state: SlideState
  /** The printer, for the slide's spoken name and the end ring's. */
  printer: string
  /** The words in the track once the person let go: sending, sent or not sent. */
  label?: string
  /** The end ring's words, for its tooltip and spoken name. */
  endLabel: string
  onComplete: () => void
}

export function SlideToPrint({ state, printer, label, endLabel, onComplete }: SlideToPrintProps) {
  const track = useRef<HTMLDivElement>(null)
  const knob = useRef<HTMLSpanElement>(null)
  // how far the knob is along its travel, 0 to 1
  const [at, setAt] = useState(0)
  const [dragging, setDragging] = useState(false)
  const from = useRef<{ x: number; at: number } | null>(null)
  const live = state === 'ready'
  const done = state === 'sending' || state === 'sent' || state === 'failed'

  // the knob goes home whenever the slide can't be used, and sits at the end once it was used
  useEffect(() => {
    if (!live && !done) setAt(0)
    if (done) setAt(1)
  }, [live, done])

  const travel = (): number => {
    const t = track.current?.clientWidth ?? 0
    const k = knob.current?.offsetWidth ?? 0
    // the knob's inset on both sides of the track
    return Math.max(1, t - k - 8)
  }
  const finish = (): void => {
    setAt(1)
    onComplete()
  }

  const down = (e: PointerEvent<HTMLSpanElement>): void => {
    if (!live) return
    // a person's drag keeps the knob even when the pointer leaves the track
    if (typeof e.currentTarget.setPointerCapture === 'function') e.currentTarget.setPointerCapture(e.pointerId)
    from.current = { x: e.clientX, at }
    setDragging(true)
  }
  const move = (e: PointerEvent<HTMLSpanElement>): void => {
    if (!from.current) return
    setAt(Math.max(0, Math.min(1, from.current.at + (e.clientX - from.current.x) / travel())))
  }
  const up = (e: PointerEvent<HTMLSpanElement>): void => {
    if (!from.current) return
    const reach = Math.max(0, Math.min(1, from.current.at + (e.clientX - from.current.x) / travel()))
    from.current = null
    setDragging(false)
    if (live && reach >= SLIDE_DONE_AT) finish()
    else setAt(0)
  }
  const cancel = (): void => {
    from.current = null
    setDragging(false)
    setAt(0)
  }
  const key = (e: KeyboardEvent<HTMLSpanElement>): void => {
    if (!live) return
    const now = Math.round(at * 100)
    const next = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? now + STEP : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? now - STEP : e.key === 'Home' ? 0 : e.key === 'End' ? 100 : null
    if (next === null) return
    e.preventDefault()
    const v = Math.max(0, Math.min(100, next))
    if (v >= 100) finish()
    else setAt(v / 100)
  }

  const shown = done ? 1 : at
  return (
    <div
      ref={track}
      className="slide-print"
      data-testid="mimir-send-slide"
      data-state={state}
      data-dragging={dragging || undefined}
      style={{ '--slide-at': shown } as CSSProperties}
    >
      <span className="slide-print-fill" aria-hidden="true" />
      <span className="slide-print-text" aria-hidden={done ? undefined : true}>
        {done ? (
          label
        ) : (
          <>
            {SLIDE_TO_PRINT}
            <Icon name="chevron-right" size={14} />
          </>
        )}
      </span>
      <button type="button" className="slide-print-end" data-testid="danger-mimir-send-print" aria-label={endLabel} title={endLabel} disabled={!live} onClick={finish}>
        {state === 'sending' ? <span className="slide-print-spin" aria-hidden="true" /> : state === 'sent' ? <Icon name="check" size={16} /> : null}
      </button>
      <span
        ref={knob}
        className="slide-print-knob"
        role="slider"
        tabIndex={live ? 0 : -1}
        aria-label={SLIDE_NAME(printer)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown * 100)}
        aria-disabled={!live || undefined}
        data-testid="mimir-send-knob"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onKeyDown={key}
        hidden={done}
      >
        <Icon name="arrow-right" size={16} />
      </span>
    </div>
  )
}
