// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Number fields with a scrub handle: drag the handle left or right to change the value, Shift for
// 10x, Alt for 0.1x, Escape to put it back. Up and Down step by the same rules from the keyboard.
// Typed values commit on Enter or blur, so one edit or one drag is one call to onCommit.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

export type Axis = 'x' | 'y' | 'z'

export interface ScrubNumberProps {
  /** Every control needs a stable id. */
  id: string
  value: number
  /** The spoken name, such as "Position X, millimeters". */
  ariaLabel: string
  /** A typed value, a step from the keyboard, or the end of a drag. */
  onCommit: (v: number) => void
  /** The live value while dragging, for a preview. Without onCancel, Escape previews the start value again. */
  onPreview?: (v: number) => void
  /** Escape during a drag that previewed: undo the preview. */
  onCancel?: () => void
  /** An axis colors the handle and labels it with its letter. */
  axis?: Axis
  /** A plain handle when there is no axis. On by default with an axis. */
  handle?: boolean
  /** Shown faintly after the value while the field has focus. */
  unit?: string
  /** Decimals shown and kept. */
  digits?: number
  /** One step of the keyboard and of a drag. */
  step?: number
  /** How far a drag goes for one step. */
  pixelsPerStep?: number
  min?: number
  max?: number
  disabled?: boolean
  /** Its own outline. A vector field turns this off and draws one outline for all its axes. */
  boxed?: boolean
  /** Reads typed text as a number, NaN when it does not read; the app passes one that knows named values (`wall * 2`). */
  parse?: (text: string) => number
  className?: string
}

/** A plain typed number, with a comma as the decimal point too. */
const plain = (text: string) => Number(text.replace(',', '.'))

/** 10x with Shift, 0.1x with Alt. */
export function scrubFactor(e: { shiftKey: boolean; altKey: boolean }): number {
  return e.shiftKey ? 10 : e.altKey ? 0.1 : 1
}

const DRAG_START_PX = 2

interface Drag {
  pointer: number
  el: HTMLElement
  x: number
  travel: number
  start: number
  raw: number
  out: number
  previewed: boolean
}

/** One number with a scrub handle. A real input, so typing, focus and screen readers work as usual. */
export function ScrubNumber({ id, value, ariaLabel, onCommit, onPreview, onCancel, axis, handle = axis !== undefined, unit, digits = 2, step = 1, pixelsPerStep = 1, min, max, disabled, boxed = true, parse = plain, className }: ScrubNumberProps) {
  const fmt = (n: number) => String(Number(n.toFixed(digits)) || 0)
  const shown = fmt(value)
  const [draft, setDraft] = useState(shown)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<Drag | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const selectOnUp = useRef(false)
  const skipBlur = useRef(false)
  const stopEscape = useRef<(() => void) | null>(null)
  const cancelRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    if (!drag.current) setDraft(shown)
  }, [shown])
  // Unmounted mid drag (the selection changed): the preview goes back.
  useEffect(() => () => cancelRef.current(), [])

  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
  const round = (n: number) => clamp(Number(n.toFixed(digits)) || 0)

  const commit = () => {
    const v = parse(draft.trim())
    if (draft.trim() === '' || !Number.isFinite(v) || (min !== undefined && v < min) || (max !== undefined && v > max)) {
      setDraft(shown)
      return
    }
    if (v !== Number(shown)) onCommit(v)
    // When the edit was refused (a locked object) the field goes back to what the object has.
    setDraft(shown)
  }

  const end = () => {
    const d = drag.current
    drag.current = null
    stopEscape.current?.()
    stopEscape.current = null
    setDragging(false)
    if (d?.el.hasPointerCapture?.(d.pointer)) d.el.releasePointerCapture(d.pointer)
    return d
  }

  const cancel = () => {
    const d = end()
    if (!d) return
    setDraft(fmt(d.start))
    if (d.previewed) {
      if (onCancel) onCancel()
      else onPreview?.(d.start)
    }
  }

  cancelRef.current = cancel

  const onPointerDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (disabled || e.button !== 0) return
    // No text selection and no focus move while scrubbing.
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture?.(e.pointerId)
    const typed = parse(draft.trim())
    const start = document.activeElement === input.current && draft.trim() !== '' && Number.isFinite(typed) ? round(typed) : round(value)
    drag.current = { pointer: e.pointerId, el, x: e.clientX, travel: 0, start, raw: start, out: start, previewed: false }
    // Escape belongs to the drag while it lasts, before the panel or the viewport sees it.
    const onKey = (k: globalThis.KeyboardEvent) => {
      if (k.key !== 'Escape' || !drag.current) return
      k.preventDefault()
      k.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', onKey, true)
    stopEscape.current = () => window.removeEventListener('keydown', onKey, true)
    setDragging(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointer) return
    const dx = e.clientX - d.x
    d.x = e.clientX
    d.travel += Math.abs(dx)
    if (d.travel < DRAG_START_PX) return
    d.raw = clamp(d.raw + (dx / pixelsPerStep) * step * scrubFactor(e))
    const out = round(d.raw)
    if (out === d.out) return
    d.out = out
    setDraft(fmt(out))
    if (onPreview) {
      d.previewed = true
      onPreview(out)
    }
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (!drag.current || e.pointerId !== drag.current.pointer) return
    const d = end()!
    if (d.travel < DRAG_START_PX) {
      // A click on the handle edits the value.
      input.current?.focus()
      return
    }
    if (d.out !== d.start) onCommit(d.out)
    else if (d.previewed) {
      if (onCancel) onCancel()
      else onPreview?.(d.start)
    }
    // A refused edit (a locked object) shows what the object has again.
    setDraft(shown)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    selectOnUp.current = false
    if (e.key === 'Enter') {
      commit()
      e.currentTarget.select()
    } else if (e.key === 'Escape') {
      setDraft(shown)
      skipBlur.current = true
      e.currentTarget.blur()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const typed = parse(draft.trim())
      const base = draft.trim() !== '' && Number.isFinite(typed) ? typed : value
      const next = round(base + (e.key === 'ArrowUp' ? 1 : -1) * step * scrubFactor(e))
      setDraft(fmt(next))
      if (next !== Number(shown)) onCommit(next)
    }
  }

  const grip = handle ? (
    <span className="sx-scrub-handle" data-axis={axis} aria-hidden="true" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={cancel}>
      {axis ? axis.toUpperCase() : null}
    </span>
  ) : null
  const cls = ['sx-scrub', className].filter(Boolean).join(' ')
  return (
    <span className={cls} data-boxed={boxed || undefined} data-axis={axis} data-dragging={dragging || undefined} data-handle={handle || undefined} data-disabled={disabled || undefined}>
      {grip}
      <input
        ref={input}
        id={id}
        className="sx-scrub-input"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={draft}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => {
          e.currentTarget.select()
          selectOnUp.current = true
        }}
        // The click that focused the field would put the caret down and drop the selection.
        onMouseUp={(e) => {
          if (selectOnUp.current) e.preventDefault()
          selectOnUp.current = false
        }}
        onBlur={() => {
          if (skipBlur.current) skipBlur.current = false
          else commit()
        }}
        onKeyDown={onKeyDown}
      />
      {unit ? (
        <span className="sx-scrub-unit" aria-hidden="true">
          {unit}
        </span>
      ) : null}
    </span>
  )
}

const SPOKEN: Readonly<Record<string, string>> = { mm: 'millimeters', '°': 'degrees', '%': 'percent', deg: 'degrees' }

/** The unit as a screen reader should say it. */
export function spokenUnit(unit: string): string {
  return SPOKEN[unit] ?? unit
}

export interface VectorFieldProps {
  /** Prefix for the inputs' ids: `${id}-x`, `${id}-y`, `${id}-z`. */
  id: string
  /** The row name, such as Position. */
  label: string
  /** The unit, shown once beside the name: mm, °, %. */
  unit: string
  /** The unit beside the name when it should read differently from the short one. */
  unitLabel?: string
  /** The group's spoken name when it differs from the label. */
  ariaLabel?: string
  values: readonly number[]
  axes?: readonly Axis[]
  onCommit: (axis: number, v: number) => void
  onPreview?: (axis: number, v: number) => void
  onCancel?: (axis: number) => void
  digits?: number
  step?: number
  pixelsPerStep?: number
  min?: number
  max?: number
  disabled?: boolean
  /** See ScrubNumber. */
  parse?: (text: string) => number
  className?: string
}

const XYZ: readonly Axis[] = ['x', 'y', 'z']

/**
 * A row of axis values in one outline: the name with its unit beside it on the left, then a segment per axis
 * whose colored letter is the scrub handle.
 */
export function VectorField({ id, label, unit, unitLabel, ariaLabel, values, axes = XYZ, onCommit, onPreview, onCancel, digits, step, pixelsPerStep, min, max, disabled, parse, className }: VectorFieldProps) {
  const spoken = spokenUnit(unit)
  const opt = { digits, step, pixelsPerStep, min, max, disabled, parse }
  return (
    <div className={['sx-vector', className].filter(Boolean).join(' ')} role="group" aria-label={ariaLabel ?? label}>
      <span className="sx-vector-label" aria-hidden="true">
        {label}
        {unit ? <small>{unitLabel ?? unit}</small> : null}
      </span>
      <span className="sx-vector-box">
        {axes.map((a, i) => (
          <ScrubNumber
            key={a}
            id={`${id}-${a}`}
            axis={a}
            boxed={false}
            unit={unit}
            value={values[i] ?? 0}
            ariaLabel={`${ariaLabel ?? label} ${a.toUpperCase()}${spoken ? `, ${spoken}` : ''}`}
            onCommit={(v) => onCommit(i, v)}
            {...(onPreview ? { onPreview: (v: number) => onPreview(i, v) } : {})}
            {...(onCancel ? { onCancel: () => onCancel(i) } : {})}
            {...strip(opt)}
          />
        ))}
      </span>
    </div>
  )
}

/** Drops undefined props, for exactOptionalPropertyTypes. */
function strip<T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never
}
