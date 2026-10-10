// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { prefersReducedMotion } from '../tokens'

/** What a tip shows. Keys are already formatted for the platform, one chip each. */
export interface TipContent {
  title: string
  body?: string
  keys?: string[]
  /** Shown after the tip has been visible a while (illustration or loop). */
  media?: ReactNode
  /** Why the control is unavailable; shown only for a disabled anchor. */
  reason?: string
  /** A small diagram shown with the text right away (a setting's figure). */
  figure?: ReactNode
  /** A quiet monospace line under the body, such as a setting's key in developer mode. */
  meta?: string
}

/** A registry id, or text for a one-off tip. */
export type TipSpec = string | { title: string; body?: string; key?: string; reason?: string }

/** The data attributes that mark an element as having a tip. Spread onto any element. */
export function tipAttrs(tip: TipSpec | undefined): Record<string, string> {
  if (!tip) return {}
  if (typeof tip === 'string') return { 'data-tip': tip }
  return {
    'data-tip-title': tip.title,
    ...(tip.body ? { 'data-tip-body': tip.body } : {}),
    ...(tip.key ? { 'data-tip-key': tip.key } : {}),
    ...(tip.reason ? { 'data-tip-reason': tip.reason } : {}),
  }
}

const SELECTOR = '[data-tip],[data-tip-title]'
/** An anchor with this attribute also opens its tip on a click or tap, and a second click closes it. */
const CLICK = 'data-tip-click'
const GAP = 8
const EDGE = 8
export const TIP_TIMING = { longPress: 500, touchSlop: 10, cold: 450, warm: 60, focus: 150, hide: 80, warmWindow: 400, media: 700, dialogQuiet: 300 } as const

export interface TooltipHostProps {
  /** Reads an anchor and returns its content, or null for none. */
  resolve: (el: HTMLElement) => TipContent | null
  /** False turns hover and focus tips off. The summon key and disabled reasons still work. */
  enabled?: boolean
  media?: boolean
  /** The pinned tip is summoned with this key when the pointer or focus is on an anchor. Returns true when it handled the key. */
  summonKey?: string
}

type Side = 'top' | 'bottom' | 'left' | 'right'

function anchorOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? (target.closest(SELECTOR) as HTMLElement | null) : null
}

function isDisabled(el: HTMLElement): boolean {
  return el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled === true
}

function withoutReason(c: TipContent): TipContent {
  const { reason: _reason, ...rest } = c
  return rest
}

/** Adds the tip to an element's description, keeping any it already has. */
function describe(el: HTMLElement): void {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
  if (!ids.includes('sx-tip')) el.setAttribute('aria-describedby', [...ids, 'sx-tip'].join(' '))
}

function undescribeEl(el: HTMLElement): void {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && id !== 'sx-tip')
  if (ids.length) el.setAttribute('aria-describedby', ids.join(' '))
  else el.removeAttribute('aria-describedby')
}

/**
 * The box the tip must stay clear of. An anchor names a larger box with data-tip-avoid (a selector
 * for an ancestor, such as a whole settings row), so the tip never covers the control being edited.
 */
function avoidBox(el: HTMLElement): HTMLElement {
  const sel = el.getAttribute('data-tip-avoid')
  return (sel ? (el.closest(sel) as HTMLElement | null) : null) ?? el
}

function sideFor(el: HTMLElement): Side {
  const want = el.getAttribute('data-tip-side')
  if (want === 'top' || want === 'bottom' || want === 'left' || want === 'right') return want
  const r = avoidBox(el).getBoundingClientRect()
  // A row-wide anchor sits beside the row, on the side with more room.
  if (el.hasAttribute('data-tip-avoid')) return r.left + r.width / 2 > window.innerWidth / 2 ? 'left' : 'right'
  const tb = el.closest('[role=toolbar][aria-orientation=vertical]')
  if (tb) return 'right'
  if (r.left + r.width / 2 > window.innerWidth * 0.72) return 'left'
  if (r.top + r.height / 2 > window.innerHeight * 0.85) return 'top'
  return 'bottom'
}

function place(anchor: DOMRect, tip: { w: number; h: number }, prefer: Side): { x: number; y: number; side: Side } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const fits = (s: Side) =>
    s === 'bottom' ? anchor.bottom + GAP + tip.h <= vh - EDGE : s === 'top' ? anchor.top - GAP - tip.h >= EDGE : s === 'right' ? anchor.right + GAP + tip.w <= vw - EDGE : anchor.left - GAP - tip.w >= EDGE
  const opposite: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
  const cross: Side[] = prefer === 'left' || prefer === 'right' ? ['bottom', 'top'] : ['right', 'left']
  const side = [prefer, opposite[prefer], ...cross].find(fits) ?? prefer
  let x: number
  let y: number
  if (side === 'top' || side === 'bottom') {
    x = anchor.left + anchor.width / 2 - tip.w / 2
    y = side === 'bottom' ? anchor.bottom + GAP : anchor.top - GAP - tip.h
  } else {
    y = anchor.top + anchor.height / 2 - tip.h / 2
    x = side === 'right' ? anchor.right + GAP : anchor.left - GAP - tip.w
  }
  x = Math.max(EDGE, Math.min(x, vw - EDGE - tip.w))
  y = Math.max(EDGE, Math.min(y, vh - EDGE - tip.h))
  return { x, y, side }
}

/** Where a tip renders: inside the anchor's open dialog, so a modal dialog's inert backdrop does not swallow it, else the body. */
function layerFor(anchor: HTMLElement): HTMLElement {
  const d = anchor.closest('dialog')
  return d && d.open ? d : document.body
}

type Pop = HTMLElement & { showPopover?: () => void }

/** Shows the tip as a popover, in the top layer over any modal dialog. Browsers without popovers keep it fixed in place. */
function toTopLayer(el: HTMLElement): void {
  try {
    if (!el.matches(':popover-open')) (el as Pop).showPopover?.()
  } catch {
    // No popover support.
  }
}

/**
 * One tooltip for the whole app. Elements opt in with data attributes (see tipAttrs); the host
 * listens on the document, so nothing per control is mounted. Timing and behavior follow the
 * feature tooltip spec: 450 ms cold, 60 ms warm, 150 ms on keyboard focus, hoverable, Esc dismisses.
 * The tip is a popover, so it shows over a modal dialog too. An anchor marked data-tip-click also
 * opens on a click or tap and stays open until the next click or Esc.
 */
export function TooltipHost({ resolve, enabled = true, media = true, summonKey = '?' }: TooltipHostProps) {
  const [shown, setShown] = useState<{ anchor: HTMLElement; layer: HTMLElement; content: TipContent; pinned: boolean; warm: boolean; touch: boolean; still: boolean } | null>(null)
  const [mediaOn, setMediaOn] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number; side: Side } | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const live = useRef({ enabled, resolve })
  live.current = { enabled, resolve }
  const state = useRef({ show: 0, hide: 0, lastHidden: 0, hover: null as HTMLElement | null, down: false, dialogAt: 0, overTip: false, current: null as HTMLElement | null, described: [] as HTMLElement[], pinned: false, pending: null as HTMLElement | null, press: 0, pressAt: null as { x: number; y: number } | null, touchShown: false, suppressClick: false, clickPinned: false, wasClickPinned: false })

  useEffect(() => {
    const s = state.current
    const clear = () => {
      s.pending = null
      window.clearTimeout(s.show)
      window.clearTimeout(s.hide)
    }
    const undescribe = () => {
      for (const el of s.described) undescribeEl(el)
      s.described = []
    }
    const hide = () => {
      clear()
      undescribe()
      if (s.current) s.lastHidden = performance.now()
      s.current = null
      s.pinned = false
      s.clickPinned = false
      setShown(null)
      setMediaOn(false)
      setPos(null)
    }
    const reveal = (anchor: HTMLElement, pinned: boolean, touch = false) => {
      // A control whose menu or popover is open says what it does there; a tip would cover the menu and take its clicks.
      if (!pinned && anchor.getAttribute('aria-expanded') === 'true') return
      const content = live.current.resolve(anchor)
      if (!content) return
      if (!pinned && !live.current.enabled && !(isDisabled(anchor) && content.reason)) return
      const warm = performance.now() - s.lastHidden < TIP_TIMING.warmWindow || s.current !== null
      undescribe()
      s.current = anchor
      s.pinned = pinned
      // The anchor and, when focus is inside it, the focused control are described by the tip.
      const focused = document.activeElement
      s.described = focused instanceof HTMLElement && focused !== anchor && anchor.contains(focused) ? [anchor, focused] : [anchor]
      for (const el of s.described) describe(el)
      setMediaOn(false)
      setShown({ anchor, layer: layerFor(anchor), content: isDisabled(anchor) ? content : withoutReason(content), pinned, warm, touch, still: prefersReducedMotion() })
    }
    const schedule = (anchor: HTMLElement, delay: number) => {
      window.clearTimeout(s.hide)
      if (s.current === anchor) return
      // Moving between children of the same anchor keeps the timer running.
      if (s.pending === anchor) return
      window.clearTimeout(s.show)
      s.pending = anchor
      const warm = s.current !== null || performance.now() - s.lastHidden < TIP_TIMING.warmWindow
      s.show = window.setTimeout(() => {
        s.pending = null
        reveal(anchor, false)
      }, warm ? Math.min(delay, TIP_TIMING.warm) : delay)
    }
    const leave = () => {
      s.pending = null
      window.clearTimeout(s.show)
      // A tip opened by a click stays until the next click or Esc, so a touch lifting off does not close it.
      if (s.clickPinned || (s.pinned && s.overTip)) return
      window.clearTimeout(s.hide)
      s.hide = window.setTimeout(() => {
        if (!s.overTip) hide()
      }, TIP_TIMING.hide)
    }
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      const a = anchorOf(e.target)
      s.hover = a
      if (!a) return leave()
      if (s.down || e.buttons !== 0 || performance.now() - s.dialogAt < TIP_TIMING.dialogQuiet) return
      schedule(a, TIP_TIMING.cold)
    }
    const out = (e: PointerEvent) => {
      const a = anchorOf(e.target)
      if (!a) return
      const to = anchorOf(e.relatedTarget)
      if (to === a) return
      if (s.hover === a) s.hover = null
      leave()
    }
    const focusIn = (e: FocusEvent) => {
      const a = anchorOf(e.target)
      // A click that focuses a field is not a request for its tip; text fields match :focus-visible either way.
      if (!a || s.down || !(e.target as HTMLElement).matches(':focus-visible')) return
      schedule(a, TIP_TIMING.focus)
    }
    const focusOut = () => leave()
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        // A touch has no hover: holding for half a second shows the tip above the finger until release.
        const a = anchorOf(e.target)
        window.clearTimeout(s.press)
        s.touchShown = false
        if (!a) return
        s.pressAt = { x: e.clientX, y: e.clientY }
        s.press = window.setTimeout(() => {
          s.touchShown = true
          reveal(a, false, true)
        }, TIP_TIMING.longPress)
        return
      }
      s.down = true
      const a = anchorOf(e.target)
      s.wasClickPinned = a !== null && s.current === a && s.clickPinned
      hide()
    }
    const touchMove = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !s.pressAt || s.touchShown) return
      if (Math.hypot(e.clientX - s.pressAt.x, e.clientY - s.pressAt.y) > TIP_TIMING.touchSlop) window.clearTimeout(s.press)
    }
    const up = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        window.clearTimeout(s.press)
        s.pressAt = null
        if (s.touchShown) {
          // The press showed a tip, so the release is not a tap on the control.
          s.touchShown = false
          s.suppressClick = true
          window.setTimeout(() => (s.suppressClick = false), 400)
          hide()
        }
        return
      }
      s.down = false
    }
    const clickCapture = (e: MouseEvent) => {
      if (s.suppressClick) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      const a = anchorOf(e.target)
      if (a?.hasAttribute(CLICK)) {
        // A click toggles the tip; the pointer press before it already hid one that was open.
        const close = s.wasClickPinned || (s.current === a && s.clickPinned)
        s.wasClickPinned = false
        hide()
        if (close) return
        reveal(a, true, (e as PointerEvent).pointerType === 'touch')
        s.clickPinned = true
        return
      }
      hide()
    }
    const noMenu = (e: Event) => {
      if (s.touchShown && anchorOf(e.target)) e.preventDefault()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && s.current) {
        // Esc closes the tip first; the dialog under it stays open.
        if (s.current.closest('dialog')) e.preventDefault()
        hide()
        return
      }
      if (e.key !== summonKey || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      const a = s.hover ?? anchorOf(document.activeElement)
      if (!a || !live.current.resolve(a)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      clear()
      reveal(a, true)
    }
    const scroll = () => {
      if (s.current && !s.pinned) hide()
    }
    const watchDialogs = new MutationObserver((list) => {
      for (const m of list) for (const n of Array.from(m.addedNodes)) if (n instanceof HTMLElement && (n.matches('[role=dialog]') || n.querySelector('[role=dialog]'))) s.dialogAt = performance.now()
    })
    watchDialogs.observe(document.body, { childList: true, subtree: true })
    document.addEventListener('pointerover', over, true)
    document.addEventListener('pointerout', out, true)
    document.addEventListener('focusin', focusIn, true)
    document.addEventListener('focusout', focusOut, true)
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up, true)
    document.addEventListener('pointercancel', up, true)
    document.addEventListener('click', clickCapture, true)
    document.addEventListener('pointermove', touchMove, true)
    document.addEventListener('contextmenu', noMenu, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('blur', hide)
    return () => {
      clear()
      watchDialogs.disconnect()
      document.removeEventListener('pointerover', over, true)
      document.removeEventListener('pointerout', out, true)
      document.removeEventListener('focusin', focusIn, true)
      document.removeEventListener('focusout', focusOut, true)
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('pointerup', up, true)
      document.removeEventListener('pointercancel', up, true)
      document.removeEventListener('click', clickCapture, true)
      document.removeEventListener('pointermove', touchMove, true)
      document.removeEventListener('contextmenu', noMenu, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('blur', hide)
    }
  }, [summonKey])

  // Turning tips off hides one that is showing, unless it was summoned.
  useEffect(() => {
    if (!enabled && shown && !shown.pinned && !shown.content.reason) setShown(null)
  }, [enabled, shown])

  // Media stage starts a while after the tip appears.
  useEffect(() => {
    if (!shown?.content.media || !media) return
    const t = window.setTimeout(() => setMediaOn(true), TIP_TIMING.media)
    return () => window.clearTimeout(t)
  }, [shown, media])

  useLayoutEffect(() => {
    const el = tipRef.current
    if (!shown || !el) return
    toTopLayer(el)
    const measure = () => {
      const r = el.getBoundingClientRect()
      setPos(place(avoidBox(shown.anchor).getBoundingClientRect(), { w: r.width, h: r.height }, shown.touch ? 'top' : sideFor(shown.anchor)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [shown, mediaOn])

  if (!shown || typeof document === 'undefined') return null
  const { content } = shown
  return createPortal(
    <div
      ref={tipRef}
      id="sx-tip"
      role="tooltip"
      popover="manual"
      className="sx-tip sx-overlay"
      data-side={pos?.side}
      data-warm={shown.warm ? true : undefined}
      data-fig={content.figure ? true : undefined}
      data-still={shown.still ? true : undefined}
      data-ready={pos ? true : undefined}
      style={{ left: pos?.x ?? 0, top: pos?.y ?? 0 }}
      onPointerEnter={() => {
        state.current.overTip = true
        window.clearTimeout(state.current.hide)
      }}
      onPointerLeave={() => {
        state.current.overTip = false
        state.current.hide = window.setTimeout(() => {
          for (const el of state.current.described) undescribeEl(el)
          state.current.described = []
          state.current.current = null
          setShown(null)
        }, TIP_TIMING.hide)
      }}
    >
      <div className="sx-tip-head">
        <span className="sx-tip-title">{content.title}</span>
        {content.keys?.map((k, i) => (
          <kbd key={i} className="sx-tip-key sx-mono">
            {k}
          </kbd>
        ))}
      </div>
      {content.body ? <p className="sx-tip-body">{content.body}</p> : null}
      {content.figure ? (
        <div className="sx-tip-fig" aria-hidden="true">
          {content.figure}
        </div>
      ) : null}
      {content.meta ? <p className="sx-tip-meta">{content.meta}</p> : null}
      {content.media && media ? (
        <div className="sx-tip-media" data-open={mediaOn ? true : undefined} aria-hidden="true">
          {mediaOn ? content.media : null}
        </div>
      ) : null}
      {content.reason ? <p className="sx-tip-reason">{content.reason}</p> : null}
    </div>,
    shown.layer,
  )
}
