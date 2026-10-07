// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's strike marks on the layer strip and the playback sliders, and the strike list. They show only after a slice with collisions,
// so they load then (lazy, through strike-slots.tsx) and add nothing to the code the web shell starts with.
import type { PreviewBuffers } from '@slicerx/contracts'
import { Icon, tipAttrs } from '@slicerx/ui'
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

/** Marks beside the vertical layer strip; `y` is a layer's share from the top. */
export function StripStrikes({ y }: { y: (layer: number) => number }) {
  const { strikes, title } = useStrikes()
  return (
    <>
      {strikes.map((c, i) => (
        <button key={`strike-${i}`} type="button" className="lstrike" data-severity={c.severity} style={{ top: `${y(c.layer + 1) * 100}%` }} aria-label={`${title(i)}, layer ${c.layer + 1}`} {...tipAttrs({ title: title(i), body: `Layer ${c.layer + 1}. Click to jump there.` })} onPointerDown={(e) => e.stopPropagation()} onClick={() => jumpTo(i)}>
          <Icon name="strike" size={14} />
        </button>
      ))}
    </>
  )
}

/** Marks on the horizontal layer slider. */
export function TrackStrikes({ share }: { share: (layer: number) => number }) {
  const { strikes, title } = useStrikes()
  return (
    <>
      {strikes.map((c, i) => (
        <button key={`strike-${i}`} type="button" className="layer-mark strike-mark" data-kind="strike" data-severity={c.severity} style={{ left: `${share(c.layer + 1)}%` }} aria-label={`${title(i)}, layer ${c.layer + 1}`} {...tipAttrs({ title: title(i), body: `Layer ${c.layer + 1}. Click to jump there.` })} onClick={() => jumpTo(i)}>
          <Icon name="strike" size={14} />
        </button>
      ))}
    </>
  )
}

/** Ticks on the Time slider at each strike's first moment. */
export function TimeStrikes({ timeline }: { timeline: Timeline }) {
  const { strikes, title } = useStrikes()
  return (
    <>
      {strikes.map((c, i) => {
        const at = collisionTime(get(), c)
        return at === null ? null : (
          <button key={i} type="button" className="strike-tick" data-severity={c.severity} style={{ left: `${(sliderOf(timeline, at) / Math.max(1, timeline.total)) * 100}%` }} aria-label={`${title(i)}, ${clock(at)}`} {...tipAttrs({ title: title(i), body: `${clock(at)}. Click to jump there.` })} onClick={() => jumpTo(i)}>
            <Icon name="strike" size={12} />
          </button>
        )
      })}
    </>
  )
}

/** Ticks on the Moves slider for the strikes of the top layer. */
export function MoveStrikes({ timeline, preview, top, segs }: { timeline: Timeline; preview: PreviewBuffers; top: number; segs: number }) {
  const { strikes, title } = useStrikes()
  return (
    <>
      {strikes.map((c, i) =>
        c.layer === top - 1 ? (
          <button key={i} type="button" className="strike-tick" data-severity={c.severity} style={{ left: `${movesOf(timeline, preview, top, segs > 0 ? c.segment / segs : 0) * 100}%` }} aria-label={`${title(i)}, move ${c.segment + 1}`} {...tipAttrs({ title: title(i), body: `Move ${c.segment + 1} of this layer. Click to jump there.` })} onClick={() => jumpTo(i)}>
            <Icon name="strike" size={12} />
          </button>
        ) : null,
      )}
    </>
  )
}
