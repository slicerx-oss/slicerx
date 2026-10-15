// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The dimension boxes on the shape (sketch-boxes.ts says where they go and what they set). Each box is one small field
// with its name and unit: it shows the shape's size as it is now, and a typed value locks it (the box fills with the
// accent) until Enter places the shape or sets the size. Tab moves to the next box and on out of them, never trapped;
// Esc first frees a typed value, then leaves the boxes. A box that only shows the live size passes the sketch's tool
// keys (L, R, C, D, T) on, so drawing never needs a click away first.
//
// Speed: the hover path moves the boxes and writes their live values through `show`, without a React render.
import { forwardRef, useEffect, useImperativeHandle, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { placeBoxes, type Area, type BoxKey, type ScreenShape } from './sketch-boxes'

// the controls that float over the view: the pill and view buttons along the top (a phone's undo group and handles
// too), the plate HUD, and a phone's bottom bar and open tool sheet. A box never sits under one.
const FLOATING = '.hud-top .hud-row, .hud-top .phandles, .hud-top .hud-col.end > *, .hud-bl > *, .pbar-wrap > *, .pane.sheet.sheet-open'

/** Where those controls are on screen, client px. */
export function floatingControls(): Area[] {
  return Array.from(document.querySelectorAll<HTMLElement>(FLOATING))
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }))
}

const signature = (rects: readonly Area[]): string => JSON.stringify(rects.map((r) => [r.left, r.top, r.right, r.bottom].map(Math.round)))

export interface ShapeBoxField {
  key: BoxKey
  label: string
  unit: string
  /** A kept shape's box: 'driving' when its dimension moves the shape, 'driven' when one only reports it. */
  set?: 'driving' | 'driven' | null
}

export interface ShapeBoxesHandle {
  /** Puts the boxes on `shape` (client px) with the live values, one per field. */
  show(shape: ScreenShape, live: readonly string[]): void
  hide(): void
}

export interface ShapeBoxesProps {
  fields: readonly ShapeBoxField[]
  /** The view's box in client px, which the boxes stay inside. */
  area: () => Area | null
  /** The box typing goes to. */
  focus: number
  /** Typed text, one per field ('' where nothing is typed), or null while every box shows its live value. */
  text: readonly string[] | null
  /** Bumped to put the keyboard in the focused box: its value all picked, or the caret after typed text. */
  focusToken: number
  /** What the boxes are for, for their group's name and test id: drawing a shape, or a picked one. */
  mode: 'draw' | 'edit'
  onFocus: (i: number) => void
  onChange: (text: string[]) => void
  /** Enter. `cleared` lists the boxes the person emptied, to free those sizes. */
  onCommit: (cleared: number[]) => void
  /** Esc in a box with nothing typed in it. */
  onEscape: () => void
  /** Tab past the last box, or Shift+Tab before the first. */
  onLeave: (back: boolean) => void
  /** A tool key in a box that only shows its live value; true when it was taken. */
  onToolKey?: (key: string) => boolean
  /** The view under the boxes: a pointer moving over a box still moves the drawing, as it would over the view. */
  view?: () => HTMLElement | null | undefined
}

export const ShapeBoxes = forwardRef<ShapeBoxesHandle, ShapeBoxesProps>(function ShapeBoxes({ fields, area, focus, text, focusToken, mode, onFocus, onChange, onCommit, onEscape, onLeave, onToolKey, view }, ref) {
  const wraps = useRef<(HTMLLabelElement | null)[]>([])
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  const last = useRef<{ shape: ScreenShape; live: readonly string[] } | null>(null)
  // boxes the person has typed in since the last commit, which no live value overwrites
  const touched = useRef(new Set<number>())
  // set when a click or tap picks a box's live value, until the button comes up
  const picked = useRef(false)
  // the floating controls the boxes were last placed clear of
  const placedAgainst = useRef('')
  const textRef = useRef(text)
  textRef.current = text
  if (text === null) touched.current.clear()

  const paint = () => {
    const l = last.current
    wraps.current.forEach((w) => w && (w.hidden = !l))
    if (!l) return
    l.live.forEach((v, i) => {
      const input = inputs.current[i]
      if (!input) return
      const typed = textRef.current?.[i] ?? ''
      if (typed !== '') {
        if (input.value !== typed) input.value = typed
      } else if (!touched.current.has(i)) {
        if (input.value !== v) input.value = v
        // a focused box keeps its live value picked, so typing replaces it
        if (document.activeElement === input) input.select()
      }
      input.placeholder = v
      // the field grows with a long value, so every digit shows (7ch holds the usual ones)
      input.style.width = `max(7ch, calc(${Math.max(input.value.length, v.length) + 1}ch + 2 * var(--s-1)))`
    })
    const sizes: Partial<Record<BoxKey, { w: number; h: number }>> = {}
    fields.forEach((f, i) => {
      const w = wraps.current[i]
      if (w) sizes[f.key] = { w: w.offsetWidth, h: w.offsetHeight }
    })
    const floating = floatingControls()
    placedAgainst.current = signature(floating)
    for (const s of placeBoxes(l.shape, sizes, area(), floating)) {
      const w = wraps.current[fields.findIndex((f) => f.key === s.key)]
      if (!w) continue
      w.style.left = `${s.left}px`
      w.style.top = `${s.top}px`
    }
  }

  const paintNow = useRef(paint)
  paintNow.current = paint
  // The floating controls come and go and move (a phone's sheet folds, a bar grows), which no event of the view reports:
  // while the boxes show, look at them a few times a second and place the boxes again when one has moved.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (last.current && signature(floatingControls()) !== placedAgainst.current) paintNow.current()
    }, 200)
    return () => window.clearInterval(id)
  }, [])

  useImperativeHandle(ref, () => ({
    show(shape, live) {
      last.current = { shape, live }
      paint()
    },
    hide() {
      last.current = null
      paint()
    },
  }))
  useEffect(paint)

  useEffect(() => {
    if (!focusToken) return
    const el = inputs.current[focus]
    if (!el) return
    el.focus({ preventScroll: true })
    const typed = textRef.current?.[focus] ?? ''
    if (typed !== '') el.setSelectionRange(el.value.length, el.value.length)
    else el.select()
    // only a new token moves the keyboard
  }, [focusToken])

  const onKey = (i: number) => (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const typed = textRef.current?.[i] ?? ''
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      onCommit(fields.flatMap((_, k) => (touched.current.has(k) && (inputs.current[k]?.value ?? '').trim() === '' ? [k] : [])))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (typed !== '' || touched.current.has(i)) {
        // a typed value goes first: the box shows the live size again, still focused
        touched.current.delete(i)
        onChange(fields.map((_, k) => (k === i ? '' : (textRef.current?.[k] ?? ''))))
        const el = e.currentTarget
        requestAnimationFrame(() => el.select())
      } else onEscape()
    } else if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const out = e.shiftKey ? i === 0 : i === fields.length - 1
      e.preventDefault()
      if (out) onLeave(e.shiftKey)
      else onFocus(e.shiftKey ? i - 1 : i + 1)
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && typed === '' && !touched.current.has(i) && onToolKey?.(e.key.toLowerCase())) {
      e.preventDefault()
    }
  }

  // a new focus from Tab moves the keyboard there with the value picked
  const focusRef = useRef(focus)
  useEffect(() => {
    if (focusRef.current === focus) return
    focusRef.current = focus
    const el = inputs.current[focus]
    if (el && document.activeElement && inputs.current.includes(document.activeElement as HTMLInputElement)) {
      el.focus({ preventScroll: true })
      el.select()
    }
  }, [focus])

  return createPortal(
    <div className="shape-boxes" data-testid="shape-boxes" data-mode={mode} role="group" aria-label={mode === 'draw' ? 'Sizes of the shape being drawn' : 'Sizes of the picked shape'}>
      {fields.map((f, i) => {
        const typed = (text?.[i] ?? '') !== ''
        return (
          <label
            key={f.key}
            ref={(el) => void (wraps.current[i] = el)}
            className="shape-box"
            data-testid="shape-box"
            data-box={f.key}
            hidden
            {...(typed ? { 'data-typed': '' } : {})}
            {...(f.set ? { 'data-set': f.set } : {})}
            {...(i === focus ? { 'data-focus': '' } : {})}
            // a box under the pointer passes its moves on to the view, so the shape keeps following the pointer
            onPointerMove={(e) => {
              const v = view?.()
              if (!v || e.pointerType === 'touch') return
              v.dispatchEvent(new PointerEvent('pointermove', { clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary, buttons: e.buttons, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: true }))
            }}
          >
            <span className="shape-box-label">{f.label}</span>
            <input
              ref={(el) => void (inputs.current[i] = el)}
              className="shape-box-input"
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              aria-label={`${f.label} ${f.unit}`}
              size={7}
              onFocus={(e) => {
                if (i !== focus) onFocus(i)
                // a box showing its live value is all picked when clicked or tapped, so typing replaces it
                if ((textRef.current?.[i] ?? '') === '' && !touched.current.has(i)) {
                  e.currentTarget.select()
                  picked.current = true
                }
              }}
              onMouseUp={(e) => {
                // the click that focused it would put the caret down and drop the pick
                if (picked.current) e.preventDefault()
                picked.current = false
              }}
              onInput={(e) => {
                touched.current.add(i)
                const v = e.currentTarget.value
                onChange(fields.map((_, k) => (k === i ? v : (textRef.current?.[k] ?? ''))))
              }}
              onKeyDown={onKey(i)}
            />
            <span className="shape-box-unit">{f.unit}</span>
          </label>
        )
      })}
    </div>,
    document.body,
  )
})
