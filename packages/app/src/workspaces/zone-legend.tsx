// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Dual nozzle printers: names the floor areas only one nozzle reaches, with a tip on each.
import { tipAttrs } from '@slicerx/ui'
import { useMemo } from 'react'
import { nozzleZones } from '../plate/nozzle-zones'
import { set, useApp } from '../state/store'

export function ZoneLegend({ layers }: { layers: boolean }) {
  const areas = useApp((s) => s.extruderAreas)
  const bed = useApp((s) => s.bed)
  const zones = useMemo(() => nozzleZones(areas, bed), [areas, bed])
  if (zones.length === 0) return null
  return (
    <ul className={`zone-legend sx-overlay zone-${layers ? 'preview' : 'prepare'}`} aria-label="Nozzle reach">
      {zones.map((z) => (
        <li key={z.id} tabIndex={0} {...tipAttrs({ title: z.label, body: z.body })} onPointerEnter={() => set({ zoneHover: z.id })} onPointerLeave={() => set({ zoneHover: null })} onFocus={() => set({ zoneHover: z.id })} onBlur={() => set({ zoneHover: null })}>
          <i style={{ background: z.color }} />
          <span>{z.label}</span>
        </li>
      ))}
    </ul>
  )
}
