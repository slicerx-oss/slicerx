// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The estimate's breakdown, opened from the time in the Slice footer: where the time goes, the filament per slot,
// electricity and filament changes.
import { resolveSlots } from '../../filament/slots'
import { formatDuration, formatGrams, previewStats, timeRows } from '../../lib/preview-stats'
import { Swatch } from '../../parts'
import { shownSlice, useApp } from '../../state/store'
import type { FeatureId } from '@slicerx/contracts'
import { featureStyle } from '../preview/preview-hud'
import { EnergyRow } from './energy-row'

export function EstimateBreakdown() {
  const slice = useApp((s) => s.slice)
  const preview = useApp((s) => s.preview)
  // The swatches are the slots' colors, as the slice used them; a string, so the selector stays stable.
  const slotColors = useApp((s) => resolveSlots(s).map((r) => r.color).join())
  const done = shownSlice(slice)
  if (!done) return null
  const r = done.result
  const colors = slotColors.split(',')
  const rows = preview
    ? timeRows(previewStats(preview).features, r.stats.timeS, r.stats.prepareS).map((row) =>
        row.key === 'start'
          ? { ...row, color: 'var(--dim)', label: 'Heating, homing and purge' }
          : { ...row, color: featureStyle(Number(row.key) as FeatureId).color, label: featureStyle(Number(row.key) as FeatureId).label },
      )
    : []
  return (
    <div className="est-breakdown" data-testid="slice-estimate-breakdown">
      <h3 className="est-bh">Where the time goes</h3>
      {rows.length ? (
        <>
          <div className="bars" aria-hidden="true">
            {rows.map((f) => (
              <i key={f.key} style={{ flexGrow: f.seconds, background: f.color }} />
            ))}
          </div>
          <ul className="tlist">
            {rows.map((f) => (
              <li key={f.key}>
                <i style={{ background: f.color }} />
                <span>{f.label}</span>
                <b>{formatDuration(f.seconds)}</b>
                <em>{f.seconds / (r.stats.timeS || 1) < 0.01 ? '<1%' : `${Math.round((f.seconds / (r.stats.timeS || 1)) * 100)}%`}</em>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="sx-small sx-muted">{formatDuration(r.stats.timeS)} in all.</p>
      )}
      <h3 className="est-bh">Filament</h3>
      <ul className="est-slots">
        {r.stats.filamentG.map((g, i) =>
          g > 0 ? (
            <li key={i}>
              <Swatch color={colors[i] ?? 'var(--dim)'} size="sm" />
              <span>Slot {i + 1}</span>
              <b>{formatGrams(g)}</b>
            </li>
          ) : null,
        )}
      </ul>
      <dl className="est-grid">
        <EnergyRow timeS={r.stats.timeS} />
        <div>
          <dt>Filament changes</dt>
          <dd>{r.stats.toolChanges}</dd>
        </div>
        <div>
          <dt>Layers</dt>
          <dd>{r.layerCount}</dd>
        </div>
      </dl>
    </div>
  )
}
