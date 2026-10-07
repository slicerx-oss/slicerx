// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's strike marks on the layer strip and the playback sliders, and the strike list. They show only after a slice with collisions,
// so they load then (lazy, through strike-slots.tsx) and add nothing to the code the web shell starts with.
import type { PreviewBuffers } from '@slicerx/contracts'
import { Icon, tipAttrs } from '@slicerx/ui'
import { useEffect, useRef, useState } from 'react'
import { clock, movesOf, sliderOf, type Timeline } from '../../lib/preview-timeline'
import { collisionsOf } from '../../plate/heimdall'
import { collisionTime, jumpTo } from '../../plate/heimdall-jump'
import { collisionTitle, namesOf } from '../../plate/heimdall-words'
import { get, useApp } from '../../state/store'

export { CollisionList } from './collision-list'

function useStrikes() {
  const strikes = useApp(collisionsOf)
  const names = namesOf(useApp((s) => s.plate))
  return { strikes, title: (i: number) => (strikes[i] ? collisionTitle(strikes[i]!, names) : '') }
}

/** One mark on a rail: the strike's index, where it sits (0 to 1 along the rail), and its words. */
interface Mark {
  i: number
  at: number
  label: string
  body: string
}

/** The rail's length in px along `axis`, kept current as it resizes. */
function useRailPx(axis: 'x' | 'y') {
  const ref = useRef<HTMLSpanElement>(null)
  const [px, setPx] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setPx(axis === 'x' ? el.clientWidth : el.clientHeight)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [axis])
  return [ref, px] as const
}

/**
 * Marks closer than `size` px on a rail of `px` join into one, so they never overlap on a narrow screen: the first
 * strike's mark with the count beside it, its tip naming each one, a click jumping to the first.
 */
export function groupMarks(marks: readonly Mark[], px: number, size: number): Mark[][] {
  const sorted = [...marks].sort((a, b) => a.at - b.at || a.i - b.i)
  const out: Mark[][] = []
  for (const m of sorted) {
    const last = out[out.length - 1]
    if (last && px > 0 && (m.at - last[0]!.at) * px < size) last.push(m)
    else out.push([m])
  }
  return out
}

function Rail({ marks, axis, size, className, icon, severity }: { marks: Mark[]; axis: 'x' | 'y'; size: number; className: string; icon: number; severity: (i: number) => string | undefined }) {
  const [ref, px] = useRailPx(axis)
  return (
    <>
      <span ref={ref} className="strike-measure" aria-hidden="true" />
      {groupMarks(marks, px, size).map((g) => {
        const first = g[0]!
        const tip = g.length === 1 ? { title: first.label, body: first.body } : { title: `${g.length} strikes here`, body: g.map((m) => `${m.label}: ${m.body.replace(/ Click to jump there\.$/, '')}`).join(' ') + ' Click to jump to the first.' }
        return (
          <button key={first.i} type="button" className={className} data-kind={className.includes('layer-mark') ? 'strike' : undefined} data-severity={severity(first.i)} style={axis === 'x' ? { left: `${first.at * 100}%` } : { top: `${first.at * 100}%` }} aria-label={g.length === 1 ? first.label : `${g.length} strikes: ${g.map((m) => m.label).join('; ')}`} {...tipAttrs(tip)} onPointerDown={(e) => e.stopPropagation()} onClick={() => jumpTo(first.i)}>
            <Icon name="strike" size={icon} />
            {g.length > 1 ? <span className="strike-count">{g.length}</span> : null}
          </button>
        )
      })}
    </>
  )
}

/** Marks beside the vertical layer strip; `y` is a layer's share from the top. */
export function StripStrikes({ y }: { y: (layer: number) => number }) {
  const { strikes, title } = useStrikes()
  const marks = strikes.map((c, i) => ({ i, at: y(c.layer + 1), label: `${title(i)}, layer ${c.layer + 1}`, body: `Layer ${c.layer + 1}. Click to jump there.` }))
  return <Rail marks={marks} axis="y" size={24} className="lstrike" icon={14} severity={(i) => strikes[i]?.severity} />
}

/** Marks on the horizontal layer slider. */
export function TrackStrikes({ share }: { share: (layer: number) => number }) {
  const { strikes, title } = useStrikes()
  const marks = strikes.map((c, i) => ({ i, at: share(c.layer + 1) / 100, label: `${title(i)}, layer ${c.layer + 1}`, body: `Layer ${c.layer + 1}. Click to jump there.` }))
  return <Rail marks={marks} axis="x" size={24} className="layer-mark strike-mark" icon={14} severity={(i) => strikes[i]?.severity} />
}

/** Ticks on the Time slider at each strike's first moment. */
export function TimeStrikes({ timeline }: { timeline: Timeline }) {
  const { strikes, title } = useStrikes()
  const marks: Mark[] = []
  strikes.forEach((c, i) => {
    const at = collisionTime(get(), c)
    if (at !== null) marks.push({ i, at: sliderOf(timeline, at) / Math.max(1, timeline.total), label: `${title(i)}, ${clock(at)}`, body: `${clock(at)}. Click to jump there.` })
  })
  return <Rail marks={marks} axis="x" size={22} className="strike-tick" icon={12} severity={(i) => strikes[i]?.severity} />
}

/** Ticks on the Moves slider for the strikes of the top layer. */
export function MoveStrikes({ timeline, preview, top, segs }: { timeline: Timeline; preview: PreviewBuffers; top: number; segs: number }) {
  const { strikes, title } = useStrikes()
  const marks: Mark[] = []
  strikes.forEach((c, i) => {
    if (c.layer === top - 1) marks.push({ i, at: movesOf(timeline, preview, top, segs > 0 ? c.segment / segs : 0), label: `${title(i)}, move ${c.segment + 1}`, body: `Move ${c.segment + 1} of this layer. Click to jump there.` })
  })
  return <Rail marks={marks} axis="x" size={22} className="strike-tick" icon={12} severity={(i) => strikes[i]?.severity} />
}
