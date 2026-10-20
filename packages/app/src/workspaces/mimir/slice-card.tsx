// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The print run's slice card: what the run's last slice made, flat in the conversation. The plate's outline thumbnail
// (the plate picker's), the print time, the filament and the cost, then each warning as a line of its own. Open in
// Slice shows that plate in the Slice tab. Once the plate changes after slicing (an edit to it, a printer or slot
// change) the card says to slice again; it reads that plate as it is now, so it says so between runs too.
import { fmtDuration, fmtGrams, STALE_SLICE } from '@slicerx/pilot'
import { Button, Icon } from '@slicerx/ui'
import { formatCost } from '../../lib/preview-stats'
import { switchPlate } from '../../plate/plates'
import { get, showSliced, useApp } from '../../state/store'
import { PlateThumb } from '../preview/plate-thumb'
import { plateFingerprint } from './print-run'
import type { RunCardProps } from './run-cards'

export const STALE_LINE = STALE_SLICE

/** Shows plate `n` (1 based) in the Slice tab, with its toolpaths. */
export function openInSlice(n: number): void {
  const target = get().plates[n - 1]
  if (target) switchPlate(target.id)
  showSliced()
}

export function SliceCard({ run, actionable }: RunCardProps) {
  const slice = run?.slice ?? null
  const n = slice?.plate ?? 1
  // the plate as it is now: the active plate's own objects, another plate's kept ones
  const objects = useApp((s) => {
    const meta = s.plates[n - 1]
    return !meta || meta.id === s.activePlate ? s.plate : meta.objects
  })
  const bed = useApp((s) => s.bed)
  // the run's own check is read when the run changes; this one follows every edit made after the run ended. It reads
  // the slice's own plate, so showing another plate (Open in Slice on a plate that was not active) changes nothing.
  const now = useApp((s) => plateFingerprint(s, n))
  if (!slice) return null
  const stale = slice.stale || slice.fingerprint !== now
  return (
    <div className="lookup-rec slice-rec" role="group" aria-label={`Slice of plate ${n}`} data-testid="mimir-slice" data-stale={stale || undefined}>
      <div className="slice-rec-main">
        <span className="slice-rec-thumb" aria-hidden="true">
          <PlateThumb objects={objects} bed={bed} size={54} fit />
        </span>
        <div className="slice-rec-body">
          <span className="lookup-rec-t">
            <Icon name="slice" />
            <span>Plate {n} sliced</span>
          </span>
          <dl className="slice-rec-figs">
            <div>
              <dt>Time</dt>
              <dd>{fmtDuration(slice.timeS)}</dd>
            </div>
            <div>
              <dt>Filament</dt>
              <dd>{fmtGrams(slice.grams)}</dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd>{formatCost(slice.cost)}</dd>
            </div>
          </dl>
        </div>
      </div>
      {slice.warnings.length ? (
        <ul className="slice-rec-warn" aria-label="Warnings">
          {slice.warnings.map((w, i) => (
            <li key={i}>
              <Icon name="warning" size={14} />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {stale ? (
        <p className="slice-rec-stale" role="status">
          {STALE_LINE}
        </p>
      ) : null}
      {actionable ? (
        <span className="slice-rec-foot">
          <Button size="sm" variant="ghost" icon="slice" data-testid="mimir-slice-open" onClick={() => openInSlice(n)}>
            Open in Slice
          </Button>
        </span>
      ) : null}
    </div>
  )
}
