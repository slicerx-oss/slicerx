// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A pressed control stays where it was pressed. Whatever the press changes (a section opening, a note appearing or
// going above it, the text growing), the nearest scrolling container is scrolled to keep the control at the same
// height on screen, for a moment after the press while the change settles.

/** The covered controls: radios, segmented options, tabs, switches, checkboxes, selects and section headers. */
export const STATIC_CONTROLS = '[role="radio"], [role="tab"], [role="switch"], input[type="checkbox"], select, button[aria-expanded]:not([aria-haspopup]):not(.sx-edge-tab)'

function scroller(el: Element): HTMLElement | null {
  let could: HTMLElement | null = null
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if (oy !== 'auto' && oy !== 'scroll') continue
    // the nearest container that scrolls now; failing that, the nearest that can, given room at its end
    if (p.scrollHeight > p.clientHeight + 1) return p
    could ??= p
  }
  return could
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
const anchors = new Map<HTMLElement, { n: number; was: string }>()

/**
 * Keeps `el` at its height on screen for `ms`, by scrolling its container against any shift in the layout. The
 * correction runs as the layout changes, before it is painted, so the shift never shows. Scrolling by the person (or
 * by the page) during that time is left alone. A new press takes over.
 */
export function keepInPlace(el: Element, ms = 450): void {
  const box = scroller(el)
  if (!box) return
  const id = ++job
  // the browser's own scroll anchoring would move the box too, after its own pick of an anchor: off while held
  const held = anchors.get(box)
  if (held) held.n++
  else anchors.set(box, { n: 1, was: box.style.overflowAnchor })
  box.style.overflowAnchor = 'none'
  const release = () => {
    const h = anchors.get(box)
    if (h && --h.n === 0) {
      box.style.overflowAnchor = h.was
      anchors.delete(box)
    }
  }
  // where el should be on screen; a scroll by the person moves that place along with it
  let top = el.getBoundingClientRect().top
  let st = box.scrollTop
  // The hold lasts `ms`, and on a slow machine a while past the last change it saw, up to 4 times `ms`: a change
  // that lands late (a busy main thread) is still caught.
  const start = performance.now()
  let end = start + ms
  const later = () => {
    end = Math.min(start + 4 * ms, Math.max(end, performance.now() + ms / 2))
  }
  const hold = () => {
    const now = box.scrollTop
    const max = box.scrollHeight - box.clientHeight
    // a scroll we did not make is the person's, unless it is the browser pulling the end back to shorter content
    const clamped = now < st && now >= max - 1
    if (Math.abs(now - st) > 0.5 && !clamped) {
      top -= now - st
      st = now
    }
    const want = now + el.getBoundingClientRect().top - top
    if (Math.abs(want - now) > 0.25) {
      if (want > max) addRoom(box, Math.ceil(want - max) + 1)
      box.scrollTop = want
      later()
      const e = added.get(box)
      if (e) e.last = box.scrollTop
    }
    st = want
  }
  // a resize inside the box is seen after layout and before paint; the frame loop catches anything else
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    if (id !== job || !el.isConnected) return
    later()
    hold()
  })
  if (ro) for (const c of [el, ...Array.from(box.children)]) ro.observe(c)
  // A change to the content is corrected in the same task, right after it lands (a mutation's callback runs before
  // the next frame), so it holds even when frames come late or not at all (a page in the background, a busy machine).
  const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
    if (id !== job || !el.isConnected) return
    later()
    hold()
  })
  mo?.observe(box, { childList: true, subtree: true, attributes: true, characterData: true })
  const step = () => {
    if (id !== job || !el.isConnected || performance.now() >= end) {
      ro?.disconnect()
      mo?.disconnect()
      release()
      return
    }
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
