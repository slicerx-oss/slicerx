// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The collisions chip: a small chip in the view's top row, beside the legend, once a slice has a strike. It counts the
// strikes (close calls are only the profile's margin, so they stay in the list), and a click picks the next one as its
// row in the summary pane does: its parts selected, the part hit outlined and the region struck filled, the view framed
// only when they are off screen, and the pane open at the list.
import { Icon, tipAttrs } from '@slicerx/ui'
import { collisionsOf } from '../../plate/heimdall'
import { openCollisionList, pickCollision } from '../../plate/heimdall-jump'
import { useApp } from '../../state/store'

/** The places of the strikes in the slice's collisions, as a string so the selector stays stable. */
const hitsOf = (s: Parameters<typeof collisionsOf>[0]) =>
  collisionsOf(s)
    .flatMap((c, i) => (c.severity === 'hit' ? [i] : []))
    .join()

export function CollisionChip() {
  const hits = useApp(hitsOf)
  const pick = useApp((s) => s.strikePick)
  if (!hits) return null
  const list = hits.split(',').map(Number)
  const at = pick === null ? -1 : list.indexOf(pick)
  const count = `${list.length} ${list.length === 1 ? 'collision' : 'collisions'}`
  const step = `Collision ${Math.max(at, 0) + 1} of ${list.length}`
  // Both labels take the same cell, the one not shown kept invisible, so a click never resizes the chip.
  return (
    <button
      type="button"
      className="collision-chip sx-overlay"
      data-testid="collision-chip"
      {...tipAttrs({ title: list.length > 1 ? 'Show the next collision' : 'Show the collision', body: 'Select the parts it names and show where they meet.' })}
      onClick={() => {
        pickCollision(list[(at + 1) % list.length]!)
        openCollisionList()
      }}
    >
      <Icon name="strike" size={16} />
      <span className="collision-chip-text">
        <span {...(at >= 0 ? {} : { 'data-on': '' })}>{count}</span>
        <span {...(at >= 0 ? { 'data-on': '' } : {})}>{step}</span>
      </span>
    </button>
  )
}
