// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch's live numbers beside the cursor: small pills for the drawing tool's next step (X and Y for a first point,
// length and angle for a line, width and height for a rectangle). One pill has focus; typing a number edits it, Tab
// moves to the next, Enter places the point and Esc drops what was typed (typing then starts again in the first pill).
// A pill left empty takes the cursor's value.
// The pills stay inside the view and never over the point being placed: below and right of the cursor, or flipped to
// the other side near an edge. While a number is typed the group turns to edit fields, so typed and live read apart.
//
// Speed: the hover path moves the pills and writes their numbers through `show`, without a React render. React renders
// when the tool, the focus or the typed text changes.
import { forwardRef, useEffect, useImperativeHandle, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

export interface PillField {
  label: string
  unit: string
}

export interface CursorPillsHandle {
  /** Puts the pills beside the cursor at client `x`, `y` with the live values, and the snap's name when one holds. */
  show(x: number, y: number, values: readonly string[], snap: string | null): void
  hide(): void
}

export interface CursorPillsProps {
  fields: readonly PillField[]
  /** The view's box in client px, which the pills stay inside. */
  area?: () => { left: number; top: number; right: number; bottom: number } | null
  /** A tool step with no number to type shows its readout in one pill instead ("Chord 12.00 mm"). */
  text?: boolean
  /** The pill typing goes to. */
  focus: number
  /** The typed text, one per field, while a number is being typed; null while the pills only follow the cursor. */
  editing: readonly string[] | null
  onFocus: (i: number) => void
  onChange: (values: string[]) => void
  onCommit: () => void
  onCancel: () => void
}

/** Where the pills sit from the cursor, px: below and to the right, clear of the pointer. */
const OFFSET = 16
/** How close to the view's edge the pills may come, px. */
const INSET = 4

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * The pills' top left for a cursor at `x`, `y`: OFFSET below and right of it, or the same distance above or left when
 * that side would leave `area`, then held inside it. A view too small for both sides keeps the pills inside and clear
 * of the cursor's row first.
 */
export function placePills(x: number, y: number, w: number, h: number, area: Box | null): { left: number; top: number } {
  let left = x + OFFSET
  let top = y + OFFSET
  if (!area) return { left, top }
  if (left + w > area.right - INSET) left = x - OFFSET - w
  if (top + h > area.bottom - INSET) top = y - OFFSET - h
  left = Math.max(area.left + INSET, Math.min(left, area.right - INSET - w))
  top = Math.max(area.top + INSET, Math.min(top, area.bottom - INSET - h))
  return { left, top }
}

/** The next pill for Tab (or the one before for Shift+Tab), round the ends. */
export const nextPill = (focus: number, count: number, back = false): number => (count <= 0 ? 0 : (focus + (back ? count - 1 : 1)) % count)

export const CursorPills = forwardRef<CursorPillsHandle, CursorPillsProps>(function CursorPills({ fields, area, text = false, focus, editing, onFocus, onChange, onCommit, onCancel }, ref) {
  const box = useRef<HTMLDivElement | null>(null)
  const values = useRef<(HTMLElement | null)[]>([])
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  const snapRef = useRef<HTMLSpanElement | null>(null)
  // the last spot, so a render (a focus change, a typed key) keeps the pills where they were
  const last = useRef<{ x: number; y: number; values: readonly string[]; snap: string | null } | null>(null)

  const paint = () => {
    const el = box.current
    const l = last.current
    if (!el) return
    if (!l) {
      el.hidden = true
      return
    }
    el.hidden = false
    const at = placePills(l.x, l.y, el.offsetWidth, el.offsetHeight, area?.() ?? null)
    el.style.left = `${Math.round(at.left)}px`
    el.style.top = `${Math.round(at.top)}px`
    l.values.forEach((v, i) => {
      const out = values.current[i]
      if (out && out.textContent !== v) out.textContent = v
      // a pill being typed in shows the cursor's value as its hint while it is empty
      const input = inputs.current[i]
      if (input && input.placeholder !== v) input.placeholder = v
    })
    const s = snapRef.current
    if (s) {
      s.hidden = !l.snap
      if (l.snap && s.textContent !== l.snap) s.textContent = l.snap
    }
  }

  useImperativeHandle(ref, () => ({
    show(x, y, v, snap) {
      last.current = { x, y, values: v, snap }
      paint()
    },
    hide() {
      last.current = null
      paint()
    },
  }))
  // after each render the pills go back to the last spot and numbers
  useEffect(paint)

  // typing starts in the focused pill, the caret after the key that opened it
  const typing = editing !== null
  useEffect(() => {
    if (!typing) return
    const el = inputs.current[focus]
    if (!el || document.activeElement === el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [typing, focus])

  const onKey = (i: number) => (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onCommit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    } else if (e.key === 'Tab') {
      // Tab stays in the pills: the next one, or the only one
      e.preventDefault()
      if (fields.length > 1) onFocus(nextPill(i, fields.length, e.shiftKey))
    }
  }

  return createPortal(
    <div ref={box} className="sketch-pills" data-testid="sketch-pills" role="group" aria-label="Exact size" hidden {...(typing ? { 'data-typing': '' } : {})}>
      {text ? (
        <span className="sketch-pill" data-testid="sketch-pill">
          <span className="sketch-pill-value sx-mono" ref={(el) => void (values.current[0] = el)} />
        </span>
      ) : (
        fields.map((f, i) => (
          <label key={f.label} className="sketch-pill" data-testid="sketch-pill" data-label={f.label} {...(i === focus ? { 'data-focus': '' } : {})} {...(typing && (editing[i] ?? '') !== '' ? { 'data-typed': '' } : {})}>
            <span className="sketch-pill-label">{f.label}</span>
            {typing ? (
              <input
                ref={(el) => void (inputs.current[i] = el)}
                className="sketch-pill-input sx-mono"
                inputMode="decimal"
                aria-label={`${f.label} ${f.unit}`}
                value={editing[i] ?? ''}
                onFocus={() => i !== focus && onFocus(i)}
                onChange={(e) => onChange(fields.map((_, k) => (k === i ? e.target.value : (editing[k] ?? ''))))}
                onKeyDown={onKey(i)}
              />
            ) : (
              <span className="sketch-pill-value sx-mono" ref={(el) => void (values.current[i] = el)} />
            )}
            <span className="sketch-pill-unit">{f.unit}</span>
          </label>
        ))
      )}
      <span className="sketch-pill-snap" ref={snapRef} hidden />
    </div>,
    document.body,
  )
})
