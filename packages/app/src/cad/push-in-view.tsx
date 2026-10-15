// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Push and pull in the view: select a face first, then a thin arrow stands on it with a Distance box at its tip and
// the operation under the value (Pull out, Cut, Cut through). Typing replaces the value, a drag on the arrow sets it,
// Enter applies, Escape closes the tool and leaves the model alone, and a negative distance turns into Cut. The tool
// runs here, beside the view, so it works with the right pane open or shut; the panel shows the same state.
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { cameraBus } from '../plate/tools'
import { set, useApp } from '../state/store'
import { usePhoneLayout } from '../lib/phone-layout'
import { usePushTool } from './push-tool'
import { arrowGeom, boxSpot, dragDistance, distanceText, OP_LABEL, pushActions, pushOperation, usePushSnapshot, type PushSnapshot } from './push-session'
import { currentValues } from './value-table'
import { fromMmText, toMmText } from './units'
import './push-in-view.css'

type V3 = [number, number, number]
type V2 = { x: number; y: number }

interface ScreenView {
  screenOf?(p: V3): [number, number] | null
  on?(event: 'camera', fn: () => void): () => void
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)

/** Runs the push and closes the tool when it went through. */
async function applyAndClose(): Promise<void> {
  if (await pushActions()?.apply()) set({ objectTool: null })
}

/** The tool, mounted beside the view while it is open, and its arrow. */
export function PushInView() {
  usePushTool()
  const s = usePushSnapshot()
  // Enter on the view or the page applies, and Esc there closes the tool while its panel is shut (the panel's footer
  // takes Esc while it shows). A field, a menu or a dialog keeps its own keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return
      if (typing(e.target) || document.querySelector('[role="menu"], [role="dialog"][aria-modal="true"]')) return
      const t = e.target as Element | null
      const onView = t === document.body || (t instanceof HTMLCanvasElement && t.classList.contains('vp-canvas')) || !!t?.closest?.('.pp-layer')
      if (!onView) return
      const now = s
      if (e.key === 'Enter' && now?.face && now.distanceMm) {
        e.preventDefault()
        void applyAndClose()
      } else if (e.key === 'Escape' && !document.querySelector('.sx-block.cad')) {
        e.preventDefault()
        set({ objectTool: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s])
  return s?.face ? <PushArrow s={s} face={s.face} /> : null
}

function PushArrow({ s, face }: { s: PushSnapshot; face: NonNullable<PushSnapshot['face']> }) {
  const view = cameraBus()?.cad as ScreenView | undefined
  const layer = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const phone = usePhoneLayout()
  const units = useApp((st) => st.units)
  // The camera moves and the view resizes under the arrow.
  useEffect(() => view?.on?.('camera', redraw), [view])
  useEffect(() => {
    const el = layer.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => redraw())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const d = s.distanceMm ?? 0
  const rect = layer.current?.getBoundingClientRect()
  const g = view?.screenOf && rect ? arrowGeom((p) => view.screenOf!(p), face.at, face.normal, d, { x: rect.left, y: rect.top }) : null
  // first render: the layer is not measured yet
  useLayoutEffect(() => {
    if (!rect) redraw()
  })

  // The box sits beside the tip, inside the view.
  useLayoutEffect(() => {
    const b = box.current
    if (!b || !g || !rect) return
    const at = boxSpot(g.tip, { w: b.offsetWidth, h: b.offsetHeight }, { w: rect.width, h: rect.height })
    b.style.transform = `translate(${at.x}px, ${at.y}px)`
    b.style.visibility = 'visible'
  })

  // A new face: the value is selected, so typing replaces it. A phone keeps its keyboard down until the box is tapped.
  const key = `${face.objectId}:${face.at.join(',')}`
  useEffect(() => {
    if (phone) return
    // A closing menu or command bar hands focus back a moment later; the box takes it again unless another field has it.
    const take = () => {
      const el = input.current
      const at = document.activeElement
      if (!el || at === el || (at !== document.body && typing(at))) return
      el.focus({ preventScroll: true })
      el.select()
    }
    take()
    const timers = [0, 60, 160, 320].map((ms) => setTimeout(take, ms))
    // Once the person types, clicks or moves into another field, focus is theirs.
    const stop = (e: Event) => {
      if (e.type === 'focusin' && (e.target === input.current || !typing(e.target))) return
      timers.forEach(clearTimeout)
    }
    const kinds = ['keydown', 'pointerdown', 'focusin'] as const
    kinds.forEach((k) => document.addEventListener(k, stop, true))
    return () => {
      timers.forEach(clearTimeout)
      kinds.forEach((k) => document.removeEventListener(k, stop, true))
    }
  }, [key, phone])

  // What the box shows: the display unit while the tool keeps mm text.
  const [draft, setDraft] = useState<{ text: string; gave: string } | null>(null)
  const shown = units.length !== 'mm'
  const text = !shown ? s.text : draft && draft.gave === s.text ? draft.text : fromMmText(s.text, units)
  const change = (t: string) => {
    if (!shown) return pushActions()?.setText(t)
    const gave = toMmText(t, units, currentValues())
    setDraft({ text: t, gave })
    pushActions()?.setText(gave)
  }

  // A drag on the arrow sets the distance along it.
  const drag = useRef<{ x: number; y: number; d0: number; out: V2; ppm: number; id: number } | null>(null)
  const down = (e: ReactPointerEvent<SVGElement>) => {
    if (e.button !== 0 || !g || s.busy) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, d0: d, out: g.out, ppm: g.pxPerMm, id: e.pointerId }
  }
  const move = (e: ReactPointerEvent<SVGElement>) => {
    const g0 = drag.current
    if (!g0 || g0.id !== e.pointerId) return
    const along = (e.clientX - g0.x) * g0.out.x + (e.clientY - g0.y) * g0.out.y
    pushActions()?.setText(distanceText(dragDistance(g0.d0, along, g0.ppm, { alt: e.altKey, shift: e.shiftKey })))
  }
  const up = (e: ReactPointerEvent<SVGElement>) => {
    if (drag.current?.id !== e.pointerId) return
    drag.current = null
    ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
    if (!phone) {
      input.current?.focus({ preventScroll: true })
      input.current?.select()
    }
  }

  const op = pushOperation(s.distanceMm, face.thicknessMm)
  const bad = s.text.trim() !== '' && s.distanceMm === null
  const message = s.note ?? (bad ? 'Type a number, such as 5 or -3.' : null)
  const tone = op === 'cut' || op === 'through' ? 'cut' : 'pull'
  // The shaft stops short of the head.
  const len = g ? Math.hypot(g.tip.x - g.base.x, g.tip.y - g.base.y) || 1 : 1
  const ux = g ? (g.tip.x - g.base.x) / len : 0
  const uy = g ? (g.tip.y - g.base.y) / len : 0
  const head = 10
  const shaftEnd = g ? { x: g.tip.x - ux * head * 0.8, y: g.tip.y - uy * head * 0.8 } : null
  const wing = (k: number) => (g ? `${g.tip.x - ux * head + -uy * head * 0.55 * k},${g.tip.y - uy * head + ux * head * 0.55 * k}` : '')
  return (
    <div className="pp-layer" ref={layer} data-testid="push-in-view" data-op={op ?? 'none'}>
      {g && shaftEnd ? (
        <svg className="pp-arrow" data-tone={tone} width="100%" height="100%" aria-hidden="true">
          <line className="pp-halo" x1={g.base.x} y1={g.base.y} x2={shaftEnd.x} y2={shaftEnd.y} />
          <polygon className="pp-halo" points={`${g.tip.x},${g.tip.y} ${wing(1)} ${wing(-1)}`} />
          <line className="pp-shaft" x1={g.base.x} y1={g.base.y} x2={shaftEnd.x} y2={shaftEnd.y} />
          <polygon className="pp-head" points={`${g.tip.x},${g.tip.y} ${wing(1)} ${wing(-1)}`} />
          <circle className="pp-base" cx={g.base.x} cy={g.base.y} r={3} />
          {/* the grab area: the whole shaft and a disc round the tip */}
          <line className="pp-grab" data-testid="push-arrow" x1={g.base.x} y1={g.base.y} x2={g.tip.x} y2={g.tip.y} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
          <circle className="pp-grab" data-testid="push-arrow-tip" cx={g.tip.x} cy={g.tip.y} r={12} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        </svg>
      ) : null}
      <div className="pp-box sx-overlay" ref={box} role="group" aria-label="Push and pull" data-testid="push-view-box" style={{ visibility: 'hidden' }}>
        <label className="pp-row">
          <span className="pp-label">Distance</span>
          <input
            ref={input}
            className="pp-num"
            data-testid="push-view-distance"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            aria-label={`Distance in ${shown ? units.length : 'mm'}`}
            aria-invalid={message ? true : undefined}
            readOnly={s.busy}
            value={text}
            placeholder="0"
            onChange={(e) => change(e.target.value)}
            onKeyDown={(e) => {
              // Mod+Enter and the other chords stay the app's
              if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
              if (e.key === 'Enter') {
                e.preventDefault()
                void applyAndClose()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                set({ objectTool: null })
              }
            }}
          />
          <span className="pp-unit">{shown ? units.length : 'mm'}</span>
        </label>
        <span className="pp-op" data-testid="push-view-op" data-op={op ?? 'none'} aria-live="polite">
          {s.busy ? 'Working' : op ? OP_LABEL[op] : 'No change'}
        </span>
        {message ? (
          <span className="pp-msg" role="status">
            {message}
          </span>
        ) : null}
      </div>
    </div>
  )
}
