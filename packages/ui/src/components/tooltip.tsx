// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { prefersReducedMotion } from '../tokens'
import type { TipDemo } from './demo-loop'

// The loop's code (and the stage drawing it) loads with the first tip that has one, not at startup.
const DemoLoop = lazy(() => import('./demo-loop').then((m) => ({ default: m.DemoLoop })))
/** The box a loop will fill, so the tip keeps its size while the chunk loads: the stage's 296 by 166, or a recorded loop's own size. */
const demoBox = (d: TipDemo) => (d.stage ? '296 / 166' : `${d.width} / ${d.height}`)

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
  /** Short rows over the body, one per item: a name, a value and a second value, in aligned columns. */
  rows?: readonly TipRow[]
  /** A demo loop under the text: its poster from the start, the loop itself from the media stage on. */
  demo?: TipDemo
}

/** One row of a tip's list: a name, a value, and a quieter value beside it. */
export type TipRow = readonly [name: string, value: string, aside: string]

/** A registry id, or text for a one-off tip. `demo` names a demo loop for the app's resolver to add. */
export type TipSpec = string | { title: string; body?: string; key?: string; reason?: string; rows?: readonly TipRow[]; demo?: string }

/** The data attributes that mark an element as having a tip. Spread onto any element. */
export function tipAttrs(tip: TipSpec | undefined): Record<string, string> {
  if (!tip) return {}
  if (typeof tip === 'string') return { 'data-tip': tip }
  return {
    'data-tip-title': tip.title,
    ...(tip.body ? { 'data-tip-body': tip.body } : {}),
    ...(tip.key ? { 'data-tip-key': tip.key } : {}),
    ...(tip.reason ? { 'data-tip-reason': tip.reason } : {}),
    ...(tip.rows?.length ? { 'data-tip-rows': JSON.stringify(tip.rows) } : {}),
    ...(tip.demo ? { 'data-tip-demo': tip.demo } : {}),
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

export type Side = 'top' | 'bottom' | 'left' | 'right'

/** Keys that move focus by themselves: Tab, and the arrows and Home and End of a roving toolbar or list. */
const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])
/** How long after such a key a focus change still counts as the key's doing. */
const NAV_WINDOW = 400

/**
 * Tells a focus the keyboard moved (Tab, arrows) from one handed back by a closing popover or menu (Enter, Space, Esc,
 * a click) or set by code. Only the first shows a tip: focus returning to the button that opened a popover would
 * otherwise bring its tip back over the page.
 */
export function focusIntent(now: () => number = () => performance.now()) {
  let navAt = -Infinity
  return {
    /** A key went down. */
    key(key: string): void {
      navAt = NAV_KEYS.has(key) ? now() : -Infinity
    },
    /** A pointer went down. */
    pointer(): void {
      navAt = -Infinity
    },
    /** Focus arrived. True when the keyboard moved it; each key moves focus once. */
    focus(): boolean {
      const ok = now() - navAt <= NAV_WINDOW
      navAt = -Infinity
      return ok
    },
  }
}

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

/**
 * The side panel an anchor sits in, when its tip should open beside the panel: over the view, level with the anchor,
 * so it never covers the panel's next row or control. A panel as wide as half the window (a phone's sheet) has no
 * room beside it, and an anchor that names its side keeps it.
 */
function sidePanel(el: HTMLElement): { box: DOMRect; side: Side } | null {
  if (el.hasAttribute('data-tip-side') || el.closest('dialog')) return null
  const p = el.closest('.sx-rail[data-side="left"], .sx-rail[data-side="right"]')
  if (!p) return null
  const box = p.getBoundingClientRect()
  if (box.width >= window.innerWidth / 2) return null
  return { box, side: p.getAttribute('data-side') === 'left' ? 'right' : 'left' }
}

/** A box on screen. */
export type Rect = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>

/** True when a row is one of a list's stacked rows: the list is at least two rows tall and the row spans most of it. */
export function stackedRow(row: Rect, list: Rect): boolean {
  return list.height >= row.height * 2 && row.width >= list.width / 2
}

/**
 * The stacked list an anchor is a row of (the Preview legend, a menu), when its tip should open beside the list or
 * above the row, so the rows under it stay in view. An anchor that names its side or its avoid box keeps them.
 */
function rowList(el: HTMLElement): HTMLElement | null {
  if (el.hasAttribute('data-tip-side') || el.hasAttribute('data-tip-avoid')) return null
  const list = el.parentElement?.closest<HTMLElement>('ul, ol, [role=list], [role=listbox], [role=menu]')
  return list && stackedRow(el.getBoundingClientRect(), list.getBoundingClientRect()) ? list : null
}

/** A row's box widened to its list's width, so a tip beside it clears every row. */
function widen(r: Rect, box: Rect): Rect {
  const left = Math.min(box.left, r.left)
  const right = Math.max(box.right, r.right)
  return { left, right, top: r.top, bottom: r.bottom, width: right - left, height: r.height }
}

/** The box the tip is placed against: the anchor's (or its avoid box's), widened to its side panel or its list when it has one. */
function anchorRect(el: HTMLElement): Rect {
  const r = avoidBox(el).getBoundingClientRect()
  // the panel's width and anything of the anchor's past it (its edge tab), at the anchor's height
  const panel = sidePanel(el)
  if (panel) return widen(r, panel.box)
  const list = rowList(el)
  return list ? widen(r, list.getBoundingClientRect()) : r
}

function sideFor(el: HTMLElement): Side {
  const want = el.getAttribute('data-tip-side')
  if (want === 'top' || want === 'bottom' || want === 'left' || want === 'right') return want
  const panel = sidePanel(el)
  if (panel) return panel.side
  const list = rowList(el)
  if (list) {
    // beside the list, on the side with more room
    const b = list.getBoundingClientRect()
    return b.left + b.width / 2 > window.innerWidth / 2 ? 'left' : 'right'
  }
  const r = avoidBox(el).getBoundingClientRect()
  // A row-wide anchor sits beside the row, on the side with more room.
  if (el.hasAttribute('data-tip-avoid')) return r.left + r.width / 2 > window.innerWidth / 2 ? 'left' : 'right'
  const tb = el.closest('[role=toolbar][aria-orientation=vertical]')
  if (tb) return 'right'
  if (r.left + r.width / 2 > window.innerWidth * 0.72) return 'left'
  if (r.top + r.height / 2 > window.innerHeight * 0.85) return 'top'
  return 'bottom'
}

/**
 * Where a tip goes: the preferred side, else the opposite one, else across. A row of a stacked list (`above`) tries
 * above before below, so the rows under it stay in view when there is no room beside the list.
 */
export function place(anchor: Rect, tip: { w: number; h: number }, prefer: Side, view = { w: window.innerWidth, h: window.innerHeight }, above = false): { x: number; y: number; side: Side } {
  const vw = view.w
  const vh = view.h
  const fits = (s: Side) =>
    s === 'bottom' ? anchor.bottom + GAP + tip.h <= vh - EDGE : s === 'top' ? anchor.top - GAP - tip.h >= EDGE : s === 'right' ? anchor.right + GAP + tip.w <= vw - EDGE : anchor.left - GAP - tip.w >= EDGE
  const opposite: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
  const cross: Side[] = prefer === 'left' || prefer === 'right' ? (above ? ['top', 'bottom'] : ['bottom', 'top']) : ['right', 'left']
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

/** Anything a person can press, drag or type into: what a tip must not cover. */
const CONTROLS = 'button, a[href], input, select, textarea, summary, [role=button], [role=slider], [role=tab], [role=menuitem], [role=switch], [role=radio], [role=checkbox]'

/**
 * Where a tip opens above a whole bar, level with its anchor: just over the bar's painted top edge (its box and the
 * parts that stick out of it, such as a tab on its edge or a panel opening upward), then higher while it would cover a
 * control. `controls` are the boxes of the controls outside the bar. Null when there is no room above.
 */
export function placeAbove(bar: Rect, anchorX: number, tip: { w: number; h: number }, controls: readonly Rect[], view = { w: window.innerWidth, h: window.innerHeight }): { x: number; y: number; side: Side } | null {
  const x = Math.max(EDGE, Math.min(anchorX - tip.w / 2, view.w - EDGE - tip.w))
  let y = bar.top - GAP - tip.h
  // each pass lifts the tip over the highest control it still touches, so a handful settles it
  for (let i = 0; i < 8; i++) {
    const hit = controls.filter((c) => c.width > 0 && c.height > 0 && x < c.right && c.left < x + tip.w && y < c.bottom && c.top < y + tip.h)
    if (!hit.length) break
    y = Math.min(...hit.map((c) => c.top)) - GAP - tip.h
  }
  return y >= EDGE ? { x, y, side: 'top' } : null
}

/** True for a part that is hidden or see-through, which takes no room on screen. */
function unseen(el: HTMLElement): boolean {
  const st = getComputedStyle(el)
  return st.visibility === 'hidden' || st.opacity === '0'
}

/** The box an element paints: its own and those of its parts that stick out of it. */
function paintedBox(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect()
  let { left, right, top, bottom } = r
  for (const d of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
    const b = d.getBoundingClientRect()
    if (!b.width || !b.height || (b.top >= r.top && b.bottom <= r.bottom && b.left >= r.left && b.right <= r.right) || unseen(d)) continue
    left = Math.min(left, b.left)
    right = Math.max(right, b.right)
    top = Math.min(top, b.top)
    bottom = Math.max(bottom, b.bottom)
  }
  return { left, right, top, bottom, width: right - left, height: bottom - top }
}

/**
 * The tip's place for an anchor that names a bar to open over (data-tip-above, a selector for an ancestor such as the
 * playback bar): over the bar's top edge and clear of every control there. Null when the anchor names none, or the
 * view has no room above the bar.
 */
function aboveBar(anchor: HTMLElement, tip: { w: number; h: number }, view: { w: number; h: number }): { x: number; y: number; side: Side } | null {
  const sel = anchor.getAttribute('data-tip-above')
  const bar = sel ? (anchor.closest(sel) as HTMLElement | null) : null
  if (!bar) return null
  const a = anchor.getBoundingClientRect()
  const controls: Rect[] = []
  for (const c of Array.from(document.querySelectorAll<HTMLElement>(CONTROLS))) {
    if (bar.contains(c) || c.closest('#sx-tip')) continue
    const b = c.getBoundingClientRect()
    if (b.width && b.height && !unseen(c)) controls.push(b)
  }
  return placeAbove(paintedBox(bar), a.left + a.width / 2, tip, controls, view)
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
  const [shown, setShown] = useState<{ anchor: HTMLElement; layer: HTMLElement; content: TipContent; pinned: boolean; warm: boolean; glide: boolean; touch: boolean; still: boolean } | null>(null)
  const [mediaOn, setMediaOn] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number; side: Side } | null>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const live = useRef({ enabled, resolve })
  live.current = { enabled, resolve }
  const state = useRef({ show: 0, hide: 0, lastHidden: 0, hover: null as HTMLElement | null, down: false, dialogAt: 0, current: null as HTMLElement | null, described: [] as HTMLElement[], pinned: false, pending: null as HTMLElement | null, press: 0, pressAt: null as { x: number; y: number } | null, touchShown: false, suppressClick: false, clickPinned: false, wasClickPinned: false })

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
      // only a tip already on screen glides to its next anchor; one opening fresh appears in place, not from the corner
      const glide = s.current !== null
      undescribe()
      s.current = anchor
      s.pinned = pinned
      // The anchor and, when focus is inside it, the focused control are described by the tip.
      const focused = document.activeElement
      s.described = focused instanceof HTMLElement && focused !== anchor && anchor.contains(focused) ? [anchor, focused] : [anchor]
      for (const el of s.described) describe(el)
      setMediaOn(false)
      setShown({ anchor, layer: layerFor(anchor), content: isDisabled(anchor) ? content : withoutReason(content), pinned, warm, glide, touch, still: prefersReducedMotion() })
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
      // A tip opened by a click stays until the next click or Esc, so a touch lifting off does not close it. Any other
      // tip closes once the pointer leaves its control: tips never take the pointer, so one can't hold the next press.
      if (s.clickPinned) return
      window.clearTimeout(s.hide)
      s.hide = window.setTimeout(hide, TIP_TIMING.hide)
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
    const intent = focusIntent()
    const focusIn = (e: FocusEvent) => {
      const moved = intent.focus()
      const a = anchorOf(e.target)
      // A click that focuses a field is not a request for its tip; text fields match :focus-visible either way.
      if (!a || s.down || !moved || !(e.target as HTMLElement).matches(':focus-visible')) return
      schedule(a, TIP_TIMING.focus)
    }
    const focusOut = () => leave()
    const down = (e: PointerEvent) => {
      intent.pointer()
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
      intent.key(e.key)
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
    if (!(shown?.content.media || shown?.content.demo) || !media) return
    const t = window.setTimeout(() => setMediaOn(true), TIP_TIMING.media)
    return () => window.clearTimeout(t)
  }, [shown, media])

  useLayoutEffect(() => {
    const el = tipRef.current
    if (!shown || !el) return
    toTopLayer(el)
    const measure = () => {
      const r = el.getBoundingClientRect()
      const tip = { w: r.width, h: r.height }
      const view = { w: window.innerWidth, h: window.innerHeight }
      setPos(aboveBar(shown.anchor, tip, view) ?? (shown.touch ? place(avoidBox(shown.anchor).getBoundingClientRect(), tip, 'top', view) : place(anchorRect(shown.anchor), tip, sideFor(shown.anchor), view, rowList(shown.anchor) !== null)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    // a list that grows or narrows while its row's tip is open (a slice filling in the legend) moves the tip with it
    const list = shown.touch ? null : rowList(shown.anchor)
    if (list) ro.observe(list)
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
      data-glide={shown.glide ? true : undefined}
      data-fig={content.figure && !(content.demo && media) ? true : undefined}
      data-demo={content.demo && media ? true : undefined}
      data-still={shown.still ? true : undefined}
      data-ready={pos ? true : undefined}
      style={{ left: pos?.x ?? 0, top: pos?.y ?? 0 }}
    >
      <div className="sx-tip-head">
        <span className="sx-tip-title">{content.title}</span>
        {content.keys?.map((k, i) => (
          <kbd key={i} className="sx-tip-key sx-mono">
            {k}
          </kbd>
        ))}
      </div>
      {content.rows?.length ? (
        <div className="sx-tip-rows" role="list">
          {content.rows.map(([name, value, aside], i) => (
            <div key={i} role="listitem" className="sx-tip-row">
              <span>{name}</span>
              <span className="sx-tip-row-value">{value}</span>
              <span className="sx-tip-row-aside">{aside}</span>
            </div>
          ))}
        </div>
      ) : null}
      {content.body && !(content.demo?.replacesBody && media) ? <p className="sx-tip-body">{content.body}</p> : null}
      {/* a loop shows the change itself, so the setting's still figure stands down while one plays */}
      {content.figure && !(content.demo && media) ? (
        <div className="sx-tip-fig" aria-hidden="true">
          {content.figure}
        </div>
      ) : null}
      {content.demo && media ? (
        <Suspense fallback={<div className="sx-demo" style={{ aspectRatio: demoBox(content.demo) }} />}>
          <DemoLoop demo={content.demo} play={mediaOn && !shown.still} />
        </Suspense>
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
