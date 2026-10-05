'use client'
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { useEffect, type RefObject } from 'react'

export interface EdgeGlowOptions {
  /** Which side of the layout the element sits on. The glow tracks its inner edge. */
  side: 'left' | 'right'
  /** Distance in px from the inner edge at which the glow starts. */
  reach?: number
  /** Turn the effect off (for example while a drag is showing the drop glow). */
  disabled?: boolean
  /**
   * The element that draws the glow and receives the variables. It should be a leaf, so a pointer move
   * restyles one element and not the whole rail. Defaults to the measured element.
   */
  target?: RefObject<HTMLElement | null>
}

export interface GlowBox {
  left: number
  right: number
  top: number
  bottom: number
}

/** Glow strength (0 to 1, three decimals) and the pointer's height in the box, for a pointer at x, y. */
export function edgeGlow(box: GlowBox, side: 'left' | 'right', reach: number, x: number, y: number): { glow: string; y: string } {
  const edge = side === 'left' ? box.right : box.left
  const inside = x >= box.left && x <= box.right
  const outward = side === 'left' ? x - edge : edge - x
  const vertical = y >= box.top - reach && y <= box.bottom + reach
  let glow = 0
  if (vertical) {
    if (inside) glow = 1 - Math.min(1, Math.abs(outward) / Math.max(box.right - box.left, 1)) * 0.6
    else if (outward > 0) glow = Math.max(0, 1 - outward / reach)
  }
  return { glow: glow === 0 ? '0' : glow.toFixed(3), y: `${Math.round(y - box.top)}px` }
}

/**
 * Lights up a rail's inner edge as the pointer approaches it. Writes --sx-glow (0 to 1) and --sx-glow-y (px)
 * onto the target at most once per animation frame, and only when a value changed, so nothing re-renders
 * and nothing restyles while the pointer is far away. The box is measured once and again when the element
 * or the window resizes, never per move. Moves with a button held (an orbit or any other drag) are skipped
 * and the glow rests. Touch pointers are ignored.
 */
export function useEdgeGlow(ref: RefObject<HTMLElement | null>, { side, reach = 96, disabled = false, target }: EdgeGlowOptions): void {
  useEffect(() => {
    const el = ref.current
    const out = target?.current ?? el
    if (!el || !out || disabled || typeof window === 'undefined') return
    let frame = 0
    let last: { x: number; y: number } | null = null
    let box: GlowBox | null = null
    let glow = '0'
    let glowY = ''
    const rest = () => {
      last = null
      if (glow === '0') return
      glow = '0'
      out.style.setProperty('--sx-glow', '0')
    }
    const apply = () => {
      frame = 0
      if (!last) return
      box ??= el.getBoundingClientRect()
      const next = edgeGlow(box, side, reach, last.x, last.y)
      if (next.glow !== glow) {
        glow = next.glow
        out.style.setProperty('--sx-glow', glow)
      }
      // The height only shows while the glow does.
      if (glow !== '0' && next.y !== glowY) {
        glowY = next.y
        out.style.setProperty('--sx-glow-y', glowY)
      }
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      if (e.buttons !== 0) {
        rest()
        return
      }
      last = { x: e.clientX, y: e.clientY }
      if (!frame) frame = requestAnimationFrame(apply)
    }
    const remeasure = () => {
      box = null
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(remeasure)
    observer?.observe(el)
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('resize', remeasure)
    document.addEventListener('pointerleave', rest)
    window.addEventListener('blur', rest)
    return () => {
      observer?.disconnect()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('resize', remeasure)
      document.removeEventListener('pointerleave', rest)
      window.removeEventListener('blur', rest)
      if (frame) cancelAnimationFrame(frame)
      out.style.removeProperty('--sx-glow')
      out.style.removeProperty('--sx-glow-y')
    }
  }, [ref, target, side, reach, disabled])
}
