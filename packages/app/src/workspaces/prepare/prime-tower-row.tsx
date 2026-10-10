// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The prime tower in the Color tab: one switch for the tower, and under it where atlas puts it. atlas places the tower
// by itself, clear of the objects and the printer's no-go zones; a drag in the 3D view or a typed spot sets it by hand,
// and "Place automatically" hands it back.
import { Icon, Input, LinkButton, SwitchRow, tipAttrs } from '@slicerx/ui'
import { OPTION_TIPS } from '../../lib/tips'
import { moveTower, setTowerAuto, towerNote } from '../../plate/tower'
import { shownSlice, useApp } from '../../state/store'

const ATLAS_TIP = OPTION_TIPS['prime_tower.atlas']!

export function PrimeTowerRow({ enabled, onEnable }: { enabled: boolean; onEnable: (on: boolean) => void }) {
  const tower = useApp((s) => s.tower)
  const reported = useApp((s) => shownSlice(s.slice)?.result.primeTower)
  const note = towerNote(reported, tower.auto)
  return (
    <li className="tower-row">
      <SwitchRow id="set-enable_prime_tower" icon="atlas" label="Prime tower" detail="Wipes each new filament on a tower before it prints on the model." checked={enabled} onChange={onEnable} />
      {enabled ? (
        <p className="tower-place sx-small sx-muted" data-testid="slice-tower-atlas" data-auto={tower.auto ? 'true' : 'false'} {...tipAttrs({ title: ATLAS_TIP.title, body: ATLAS_TIP.body })}>
          <Icon name="atlas" size={14} />
          <span>
            {tower.auto ? (
              <>
                <b>atlas</b> places it clear of the objects and the printer's no-go zones.
              </>
            ) : (
              <>
                Set by hand. Drag the tower in the view or type a spot.{' '}
                <LinkButton onClick={() => setTowerAuto(true)}>Place automatically</LinkButton>
              </>
            )}
          </span>
        </p>
      ) : null}
      {enabled && !tower.auto ? (
        <div className="tower-xy">
          <label>
            X (mm)
            <Input id="tower-x" type="number" value={tower.x} onChange={(e) => moveTower(Number(e.currentTarget.value), tower.y)} />
          </label>
          <label>
            Y (mm)
            <Input id="tower-y" type="number" value={tower.y} onChange={(e) => moveTower(tower.x, Number(e.currentTarget.value))} />
          </label>
        </div>
      ) : null}
      {enabled && note ? (
        <p className="sx-small sx-muted seg-mark mark-atlas" role="status" {...tipAttrs({ title: ATLAS_TIP.title, body: ATLAS_TIP.body })}>
          <Icon name="atlas" size={14} />
          {note}
        </p>
      ) : null}
    </li>
  )
}
