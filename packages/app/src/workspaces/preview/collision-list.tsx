// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// heimdall's collisions in Preview: each strike with when it happens and how deep, a jump that plays the head to that
// moment, and the fixes with what they cost. A new order and print by layer apply with one click; the rest explain.
// A click or a tap on a strike's row selects the parts it names, rings them on the bed and frames them when they are
// off screen; while they are the selection the row reads as pressed, the view outlines the part hit and fills the
// region struck, and a polite live region says what was picked. Each hit names the part it hits on its row.
import type { Collision, CollisionFix } from '@slicerx/contracts'
import { Block, Button, Icon, tipAttrs } from '@slicerx/ui'
import { useState } from 'react'
import { useHost } from '../../host'
import { clock } from '../../lib/preview-timeline'
import { collisionParts, collisionsOf, damagedOf, fixesOf } from '../../plate/heimdall'
import { applyCollisionFix } from '../../plate/heimdall-fix'
import { jumpTo, pickCollision } from '../../plate/heimdall-jump'
import { collisionDetail, collisionTitle, fixDetail, fixTitle, struckLabel, wordsOf } from '../../plate/heimdall-words'
import { isPicked } from '../../plate/pick-parts'
import { get, set, shownSlice, useApp } from '../../state/store'

const KIND: Record<Collision['kind'], string> = {
  gantry: 'Gantry',
  hotend: 'Toolhead',
  nozzle_travel_through_part: 'Travel',
  path_conflict: 'Crossing paths',
  keep_out: 'Keep-out zone',
  tool_change: 'Tool change',
  dock: 'Dock',
}

function when(c: Collision): string {
  const layers = c.lastLayer > c.layer ? `layers ${c.layer + 1} to ${c.lastLayer + 1}` : `layer ${c.layer + 1}`
  const depth = c.depthMm > 0 ? `, ${c.depthMm.toFixed(1)} mm ${c.severity === 'close' || c.part === 'clearance' ? 'inside the margin' : 'deep'}` : ''
  return `${KIND[c.kind]}, from ${clock(c.timeS)}, ${layers}${depth}`
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
  const stale = useApp((s) => shownSlice(s.slice)?.stale ?? false)
  // The names follow the plate; the station follows the printer, read when the list draws.
  const plate = useApp((s) => s.plate)
  const selection = useApp((s) => s.selection)
  const selectedIds = useApp((s) => s.selectedIds)
  const { name, station } = wordsOf(get())
  const [busy, setBusy] = useState(false)
  if (!list.length) return null
  const hits = list.filter((c) => c.severity === 'hit').length
  const closes = list.length - hits
  const closeLabel = `${closes} close ${closes === 1 ? 'call' : 'calls'}`
  const label = hits ? `${hits} ${hits === 1 ? 'strike' : 'strikes'} on this plate${closes ? `, ${closeLabel}` : ''}` : closeLabel
  // What a pick selected, for a screen reader: the parts, the one hit marked, and when.
  const picked = pick !== null ? list[pick] : undefined
  const pickedParts = picked ? collisionParts({ plate }, picked) : []
  const hitPart = picked && picked.severity === 'hit' ? damagedOf({ plate }, picked) : null
  const said = picked && pickedParts.length && isPicked({ selection, selectedIds }, pickedParts) ? `Selected ${pickedParts.map((id) => `${name(id)}${id === hitPart ? ' (hit)' : ''}`).join(' and ')}. ${when(picked)}.` : ''
  return (
    <Block title="Collisions" aside={<span className={hits ? 'app-tag strike-tag' : 'app-tag'}>{label}</span>} data-section="collisions">
      <ol className="strikes" aria-label="Collisions">
        {list.map((c, i) => {
          const parts = collisionParts({ plate }, c)
          const struck = c.severity === 'hit' ? damagedOf({ plate }, c) : null
          return (
            <li key={`${c.kind}-${c.objectId}-${c.hitId}-${i}`} className={pick === i ? 'sel' : undefined} data-severity={c.severity} onPointerEnter={() => set({ strikeHover: i })} onPointerLeave={() => set({ strikeHover: null })}>
              <button type="button" className="strike-pick" data-testid="collision-select" aria-pressed={isPicked({ selection, selectedIds }, parts)} disabled={parts.length === 0} {...tipAttrs({ title: parts.length > 1 ? 'Select both' : 'Select it', body: 'Select on the plate and show where it is.' })} onClick={() => pickCollision(i)}>
                <Icon name="strike" size={18} />
                <span className="strike-text">
                  <b>{collisionTitle(c, name, station)}</b>
                  <span className="strike-detail">{collisionDetail(c, name, station)}</span>
                  {struck ? <span className="strike-struck">{struckLabel(c, name(struck))}</span> : null}
                  <span className="strike-when">{when(c)}</span>
                </span>
              </button>
              <Button size="sm" variant="ghost" aria-label={`Jump to: ${collisionTitle(c, name, station)}`} tip={{ title: 'Jump', body: 'Move the sliders to this moment and play the toolhead up to it.' }} onClick={() => jumpTo(i)}>
                Jump
              </Button>
            </li>
          )
        })}
      </ol>
      <p className="sr-only" aria-live="polite" data-testid="collision-said">
        {said}
      </p>
      {fixes.length ? (
        <>
          <h4 className="strike-fixes-h">Fixes</h4>
          <ul className="strike-fixes">
            {fixes.map((f, i) => (
              <li key={`${f.kind}-${i}`}>
                <div>
                  <b>{fixTitle(f, name, plate.map((p) => p.id), station, list)}</b>
                  <p>
                    {fixDetail(f, name, list.length, station, list)} <span className="sx-dim">{cost(f)}</span>
                  </p>
                </div>
                {f.oneClick ? (
                  <Button size="sm" disabled={busy || stale} tip={{ title: fixTitle(f, name, plate.map((p) => p.id), station, list), body: 'Apply it and slice again. Undo puts the plate back.', ...(stale ? { reason: 'Slice again first: the plate changed since this slice.' } : {}) }} onClick={() => { setBusy(true); void applyCollisionFix(host, f).finally(() => setBusy(false)) }}>
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
