// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Plates in Preview: a thumbnail per plate with whether its slice is ready. A click shows that plate; a plate
// sliced before comes back with its toolpaths at once (plate-slices.ts).
import { Block, tipAttrs } from '@slicerx/ui'
import { allPlates, switchPlate } from '../../plate/plates'
import { useApp, type SliceState } from '../../state/store'
import { keptSlice } from './plate-slices'
import { PlateThumb } from './plate-thumb'

function status(on: boolean, slice: SliceState, id: string): string {
  if (on) return slice.status === 'done' ? (slice.stale ? 'Settings changed' : 'In view') : slice.status === 'running' ? 'Slicing' : 'Not sliced'
  const k = keptSlice(id)
  return k ? (k.stale ? 'Settings changed' : 'Sliced') : 'Not sliced'
}

export function PreviewPlates() {
  const plates = useApp((s) => s.plates)
  const plate = useApp((s) => s.plate)
  const active = useApp((s) => s.activePlate)
  const bed = useApp((s) => s.bed)
  const slice = useApp((s) => s.slice)
  if (plates.length < 2) return null
  const list = allPlates({ plates, plate, activePlate: active })
  return (
    <Block title="Plates" aside={`${plates.length}`} data-section="plates">
      <ul className="pv-plates" aria-label="Plates">
        {list.map((p, i) => {
          const on = p.id === active
          const st = status(on, slice, p.id)
          return (
            <li key={p.id}>
              <button type="button" className="pv-plate" aria-current={on ? 'true' : undefined} onClick={() => switchPlate(p.id)} {...tipAttrs({ title: p.name, body: on ? 'This plate is in view.' : 'Show this plate in Preview.' })}>
                <PlateThumb objects={p.objects} bed={bed} size={52} />
                <span className="pv-plate-name">
                  <span className="sx-mono">{i + 1}</span> {p.name}
                </span>
                <small className={st === 'Settings changed' ? 'warn' : undefined}>{st}</small>
              </button>
            </li>
          )
        })}
      </ul>
    </Block>
  )
}
