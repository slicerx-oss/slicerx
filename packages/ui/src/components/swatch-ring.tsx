// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { type RefObject, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { nearPanel, panelBackground } from './swatch-contrast'

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
}

const isHex = (c: string) => /^#[0-9a-f]{6}$/i.test(c)

/**
 * A filament color as a disc with an optional usage arc, label, dim state and mismatch dot. The disc carries a thin
 * outline in the theme's line color, so white and black spools stay visible on light and dark themes alike. A color
 * close to the panel behind it (measured on the resolved colors, see swatch-contrast) gets a stronger edge in the
 * muted text color, so it never reads as an empty ring.
 */
export function SwatchRing({ color, label, usage, dim, mismatch, selected, size = 32, className }: SwatchRingProps) {
  const known = isHex(color)
  const checker = `sx-swatch-unknown-${useId().replace(/[^\w-]/g, '')}`
  const share = usage === undefined ? undefined : Math.max(0, Math.min(1, usage))
  // the arc runs on a circle of radius 15 in a 32 box, from twelve o'clock clockwise
  const length = 2 * Math.PI * 15
  const edge = useNearPanel(known ? color : null)
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
        {known ? null : (
          <pattern id={checker} width="6" height="6" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" className="sx-swatch-check-a" />
            <rect width="3" height="3" className="sx-swatch-check-b" />
            <rect x="3" y="3" width="3" height="3" className="sx-swatch-check-b" />
          </pattern>
        )}
        {share === undefined ? null : <circle className="sx-swatch-track" cx="16" cy="16" r="15" />}
        {share ? <circle className="sx-swatch-arc" cx="16" cy="16" r="15" strokeDasharray={`${(share * length).toFixed(2)} ${length.toFixed(2)}`} transform="rotate(-90 16 16)" /> : null}
        <circle className="sx-swatch-disc" cx="16" cy="16" r="12" fill={known ? color : `url(#${checker})`} />
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
    const check = () => {
      const panel = panelBackground(el)
      setOn(panel !== null && nearPanel(color, panel))
    }
    check()
    // A theme switch changes the html element's attributes or its style; the panel's color follows.
    const watch = typeof MutationObserver === 'function' ? new MutationObserver(check) : null
    watch?.observe(document.documentElement, { attributes: true })
    return () => watch?.disconnect()
  }, [color])
  return { ref, on }
}
