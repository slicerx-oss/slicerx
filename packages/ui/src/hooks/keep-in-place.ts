// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A pressed control stays where it was pressed. Whatever the press changes (a section opening, a note appearing or
// going above it, the text growing), the nearest scrolling container is scrolled to keep the control at the same
// height on screen, for a moment after the press while the change settles.

/** The covered controls: radios, segmented options, tabs, switches, checkboxes, selects and section headers. */
export const STATIC_CONTROLS = '[role="radio"], [role="tab"], [role="switch"], input[type="checkbox"], select, button[aria-expanded]:not([aria-haspopup]):not(.sx-edge-tab)'

function scroller(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    // The nearest container that scrolls now; one that could scroll but has nothing to scroll is passed over.
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p
  }
  return null
}

const added = new WeakMap<HTMLElement, { px: number; spacer: HTMLElement; last: number }>()

/**
 * Room at the bottom of `box`, so a section closing above the end of a long list never pulls the scroll back (the
 * browser clamps it to the shorter content). The room goes away as the person scrolls up into it. It is an empty
 * block at the end: padding would do in a flex or grid box, but a plain block does not count it as scroll room.
 */
function addRoom(box: HTMLElement, px: number): void {
  let e = added.get(box)
  if (e) {
    e.px += px
  } else {
    const spacer = document.createElement('div')
    spacer.setAttribute('aria-hidden', 'true')
    spacer.dataset.sxRoom = ''
    spacer.style.cssText = 'flex:none;grid-column:1/-1;margin:0;padding:0;border:0;pointer-events:none'
    box.append(spacer)
    const entry = { px, spacer, last: box.scrollTop }
    e = entry
    added.set(box, entry)
    const onScroll = () => {
      const up = entry.last - box.scrollTop
      entry.last = box.scrollTop
      // the browser pulling the end back to shorter content is not the person scrolling up
      const clamped = box.scrollTop >= box.scrollHeight - box.clientHeight - 1
      if (up > 0 && !clamped) entry.px = Math.max(0, entry.px - up)
      spacer.style.height = `${entry.px}px`
      if (entry.px === 0) {
        box.removeEventListener('scroll', onScroll)
        spacer.remove()
        added.delete(box)
      }
    }
    box.addEventListener('scroll', onScroll, { passive: true })
  }
  e.spacer.style.height = `${e.px}px`
}

let job = 0

/**
 * Keeps `el` at its height on screen for `ms`, by scrolling its container against any shift in the layout. The
 * correction runs as the layout changes, before it is painted, so the shift never shows. Scrolling by the person (or
 * by the page) during that time is left alone. A new press takes over.
 */
export function keepInPlace(el: Element, ms = 450): void {
  const box = scroller(el)
  if (!box) return
  const id = ++job
  // where el sits in the scrolled content, so a layout shift and a scroll tell apart
  const at = () => el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
  let y = at()
  let st = box.scrollTop
  const end = performance.now() + ms
  const hold = () => {
    const now = box.scrollTop
    const max = box.scrollHeight - box.clientHeight
    // a scroll we did not make is the person's, unless it is the browser pulling the end back to shorter content
    const clamped = now < st && now >= max - 1
    if (Math.abs(now - st) > 0.5 && !clamped) st = now
    const next = at()
    const want = st + (next - y)
    y = next
    if (Math.abs(want - now) > 0.25) {
      if (want > max) addRoom(box, Math.ceil(want - max) + 1)
      box.scrollTop = want
      const e = added.get(box)
      if (e) e.last = box.scrollTop
    }
    st = want
  }
  // a resize inside the box is seen after layout and before paint; the frame loop catches anything else
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => id === job && el.isConnected && hold())
  if (ro) for (const c of [el, ...Array.from(box.children)]) ro.observe(c)
  const step = () => {
    if (id !== job || !el.isConnected || performance.now() >= end) return ro?.disconnect()
    hold()
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/** Installs the rule for the whole document: every press of a covered control keeps it in place. Returns an undo. */
export function keepPressedControlsInPlace(root: Document = document): () => void {
  const onPress = (e: Event) => {
    const t = e.target instanceof Element ? e.target.closest(STATIC_CONTROLS) : null
    if (t) keepInPlace(t)
  }
  root.addEventListener('pointerdown', onPress, true)
  root.addEventListener('keydown', onPress, true)
  root.addEventListener('change', onPress, true)
  return () => {
    root.removeEventListener('pointerdown', onPress, true)
    root.removeEventListener('keydown', onPress, true)
    root.removeEventListener('change', onPress, true)
  }
}
