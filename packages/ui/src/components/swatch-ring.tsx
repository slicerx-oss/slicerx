// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { type RefObject, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

export interface SwatchRingProps {
  /** #rrggbb; anything else draws as unknown (a checker). */
  color: string
  /** A slot label drawn under the disc, such as "A2". */
  label?: string
  /** Share of the plate's filament, 0 to 1, drawn as an arc around the disc. */
  usage?: number
  /** Drawn dim, for a slot nothing on the plate uses. */
  dim?: boolean
  /** A corner dot: the printer holds something else in this slot. */
  mismatch?: boolean
  /** Ring around it, for the slot in focus or picked. */
  selected?: boolean
  /** Diameter in px, 32 by default. */
  size?: number
  className?: string
  /**
   * A mixed filament: the disc draws diagonal stripes of its two colors (#rrggbb), as wide as their share of the
   * layers, in place of `color`.
   */
  mix?: { a: string; b: string; ratio: readonly [number, number] }
}

const isHex = (c: string) => /^#[0-9a-f]{6}$/i.test(c)

/**
 * A filament color as a disc with an optional usage arc, label, dim state and mismatch dot. The disc carries a thin
 * outline in the theme's line color, so white and black spools stay visible on light and dark themes alike. A color
 * close to the panel behind it (measured on the resolved colors, see swatch-contrast) gets a stronger edge in the
 * muted text color, so it never reads as an empty ring.
 */
export function SwatchRing({ color, label, usage, dim, mismatch, selected, size = 32, className, mix }: SwatchRingProps) {
  const known = isHex(color)
  const uid = useId().replace(/[^\w-]/g, '')
  const checker = `sx-swatch-unknown-${uid}`
  const striped = mix && isHex(mix.a) && isHex(mix.b) ? mix : null
  const stripeId = `sx-swatch-mix-${uid}`
  // One stripe unit is 2 of the 32 box: a cycle of a 2:1 mix is 4 of A then 2 of B.
  const unit = 2
  const cycle = striped ? (striped.ratio[0] + striped.ratio[1]) * unit : 0
  const share = usage === undefined ? undefined : Math.max(0, Math.min(1, usage))
  // the arc runs on a circle of radius 15 in a 32 box, from twelve o'clock clockwise
  const length = 2 * Math.PI * 15
  const edge = useNearPanel(known && !striped ? color : null)
  return (
    <span
      ref={edge.ref}
      className={className ? `sx-swatch-ring ${className}` : 'sx-swatch-ring'}
      data-edge={edge.on ? true : undefined}
      data-dim={dim ? true : undefined}
      data-selected={selected ? true : undefined}
      style={{ '--sw-size': `${size}px` } as CSSProperties}
    >
      <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
        {striped ? (
          <pattern id={stripeId} width={cycle} height={cycle} patternUnits="userSpaceOnUse" patternTransform="rotate(45 16 16)">
            <rect width={cycle} height={cycle} fill={striped.b} />
            <rect width={striped.ratio[0] * unit} height={cycle} fill={striped.a} />
          </pattern>
        ) : null}
        {known || striped ? null : (
          <pattern id={checker} width="6" height="6" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" className="sx-swatch-check-a" />
            <rect width="3" height="3" className="sx-swatch-check-b" />
            <rect x="3" y="3" width="3" height="3" className="sx-swatch-check-b" />
          </pattern>
        )}
        {share === undefined ? null : <circle className="sx-swatch-track" cx="16" cy="16" r="15" />}
        {share ? <circle className="sx-swatch-arc" cx="16" cy="16" r="15" strokeDasharray={`${(share * length).toFixed(2)} ${length.toFixed(2)}`} transform="rotate(-90 16 16)" /> : null}
        <circle className="sx-swatch-disc" cx="16" cy="16" r="12" fill={striped ? `url(#${stripeId})` : known ? color : `url(#${checker})`} data-mix={striped ? true : undefined} />
      </svg>
      {mismatch ? <i className="sx-swatch-mismatch" aria-hidden="true" /> : null}
      {label ? <span className="sx-swatch-label">{label}</span> : null}
    </span>
  )
}

/** Whether `color` is near the background the ring sits on, measured after layout and again when the theme changes. */
function useNearPanel(color: string | null): { ref: RefObject<HTMLSpanElement | null>; on: boolean } {
  const ref = useRef<HTMLSpanElement>(null)
  const [on, setOn] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !color || typeof getComputedStyle !== 'function') return void setOn(false)
    let live = true
    let watch: MutationObserver | null = null
    // The color math loads on first use, so it stays out of the startup shell.
    void import('./swatch-contrast').then(({ nearPanel, panelBackground }) => {
      if (!live) return
      const check = () => {
        const panel = panelBackground(el)
        setOn(panel !== null && nearPanel(color, panel))
      }
      check()
      // A theme switch changes the html element's attributes or its style; the panel's color follows.
      watch = typeof MutationObserver === 'function' ? new MutationObserver(check) : null
      watch?.observe(document.documentElement, { attributes: true })
    })
    return () => {
      live = false
      watch?.disconnect()
    }
  }, [color])
  return { ref, on }
}
