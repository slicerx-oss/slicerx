// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The exploded view over the app link: explode.get reads the spread, its axis, the selected objects it spreads and the
// offsets the view draws their parts at; explode.set changes the spread or the axis, as the Spread control over the view
// does, and answers with all of it read back. Display only, like the slice preview: no slice, export, undo step or
// saved project reads it, and it goes back to 0 when the selection changes.
import { EXPLODE_AXES, explodedNow, explodeTargets, setExplode, type ExplodeAxis } from '../plate/explode'
import { get } from '../state/store'
import { LinkError } from './methods-error'

const round = (v: number) => Math.round(v * 100) / 100

export function readExplode() {
  const s = get()
  const ids = new Set(explodeTargets(s))
  const drawn = explodedNow()
  return {
    spread: s.explode.spread,
    axis: s.explode.axis,
    targets: s.plate.filter((p) => ids.has(p.id)).map((p) => ({ id: p.id, name: p.name, parts: p.parts.length })),
    // null while no 3D view is up; objects drawn whole are left out
    drawn: drawn ? Object.fromEntries(Object.entries(drawn).map(([id, list]) => [id, list.map((o) => o.map(round))])) : null,
  }
}

/** `spread` (0 to 100, percent) and `axis` (radial, x, y or z), either or both; both are checked before either changes. */
export function setExplodeLink(args: Record<string, unknown>) {
  const extra = Object.keys(args).filter((k) => k !== 'spread' && k !== 'axis')
  if (extra.length) throw new LinkError('invalid_input', `explode.set takes spread and axis only, not ${extra.join(', ')}`)
  const { spread, axis } = args
  if (spread === undefined && axis === undefined) throw new LinkError('invalid_input', 'give spread, axis or both')
  if (spread !== undefined && (typeof spread !== 'number' || !Number.isFinite(spread) || spread < 0 || spread > 100)) throw new LinkError('invalid_input', 'spread is a number from 0 to 100 (percent)')
  if (axis !== undefined && !EXPLODE_AXES.includes(axis as ExplodeAxis)) throw new LinkError('invalid_input', `axis is one of ${EXPLODE_AXES.join(', ')}`)
  if (typeof spread === 'number' && spread > 0 && explodeTargets().length === 0) throw new LinkError('not_found', 'select an object with 2 parts or more first (ui.select); the spread applies to the selection')
  setExplode({ ...(typeof spread === 'number' ? { spread } : {}), ...(axis !== undefined ? { axis: axis as ExplodeAxis } : {}) })
  return readExplode()
}
