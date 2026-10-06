// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's collisions in Preview: each strike with when it happens and how deep, a jump that plays the head to that
// moment, and the fixes with what they cost. A new order and print by layer apply with one click; the rest explain.
import type { Collision, CollisionFix } from '@slicerx/contracts'
import { Block, Button, Icon } from '@slicerx/ui'
import { useState } from 'react'
import { useHost } from '../../host'
import { clock } from '../../lib/preview-timeline'
import { applyCollisionFix, collisionsOf, fixesOf, jumpToCollision } from '../../plate/heimdall'
import { collisionDetail, collisionTitle, fixDetail, fixTitle, wordsOf } from '../../plate/heimdall-words'
import { get, useApp } from '../../state/store'

const KIND: Record<Collision['kind'], string> = {
  gantry: 'Gantry',
  hotend: 'Toolhead',
  nozzle_travel_through_part: 'Travel',
  tool_change: 'Tool change',
  dock: 'Dock',
}

function when(c: Collision): string {
  const layers = c.lastLayer > c.layer ? `layers ${c.layer + 1} to ${c.lastLayer + 1}` : `layer ${c.layer + 1}`
  return `${KIND[c.kind]}, from ${clock(c.timeS)}, ${layers}, ${c.depthMm.toFixed(1)} mm ${c.severity === 'close' ? 'inside the margin' : 'deep'}`
}

function cost(f: CollisionFix): string {
  const s = f.costS
  if (Math.abs(s) < 1) return '+0 min'
  return Math.abs(s) < 90 ? `${s > 0 ? '+' : ''}${Math.round(s)} s` : `${s > 0 ? '+' : ''}${Math.round(s / 60)} min`
}

export function CollisionList() {
  const host = useHost()
  const list = useApp(collisionsOf)
  const fixes = useApp(fixesOf)
  const pick = useApp((s) => s.strikePick)
  const stale = useApp((s) => s.slice.status === 'done' && s.slice.stale)
  // The names follow the plate; the station follows the printer, read when the list draws.
  const plate = useApp((s) => s.plate)
  const { name, station } = wordsOf(get())
  const [busy, setBusy] = useState(false)
  if (!list.length) return null
  const hits = list.filter((c) => c.severity === 'hit').length
  const label = hits ? `${hits} ${hits === 1 ? 'strike' : 'strikes'} on this plate` : `${list.length} close ${list.length === 1 ? 'call' : 'calls'}`
  return (
    <Block title="Collisions" aside={<span className={hits ? 'app-tag strike-tag' : 'app-tag'}>{label}</span>} data-section="collisions">
      <ol className="strikes" aria-label="Collisions">
        {list.map((c, i) => (
          <li key={`${c.kind}-${c.objectId}-${c.hitId}-${i}`} className={pick === i ? 'sel' : undefined} data-severity={c.severity}>
            <Icon name="strike" size={18} />
            <div>
              <b>{collisionTitle(c, name, station)}</b>
              <p>{collisionDetail(c, name, station)}</p>
              <span className="strike-when">{when(c)}</span>
            </div>
            <Button size="sm" variant="ghost" aria-label={`Jump to: ${collisionTitle(c, name, station)}`} tip={{ title: 'Jump', body: 'Move the sliders to this moment and play the toolhead up to it.' }} onClick={() => void jumpToCollision(i)}>
              Jump
            </Button>
          </li>
        ))}
      </ol>
      {fixes.length ? (
        <>
          <h4 className="strike-fixes-h">Fixes</h4>
          <ul className="strike-fixes">
            {fixes.map((f, i) => (
              <li key={`${f.kind}-${i}`}>
                <div>
                  <b>{fixTitle(f, name, plate.map((p) => p.id), station)}</b>
                  <p>
                    {fixDetail(f, name, list.length, station)} <span className="sx-dim">{cost(f)}</span>
                  </p>
                </div>
                {f.oneClick ? (
                  <Button size="sm" disabled={busy || stale} tip={{ title: fixTitle(f, name, plate.map((p) => p.id), station), body: 'Apply it and slice again. Undo puts the plate back.', ...(stale ? { reason: 'Slice again first: the plate changed since this slice.' } : {}) }} onClick={() => { setBusy(true); void applyCollisionFix(host, f).finally(() => setBusy(false)) }}>
                    Apply
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Block>
  )
}
