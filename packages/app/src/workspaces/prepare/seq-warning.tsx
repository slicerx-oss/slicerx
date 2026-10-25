// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The by-object clearance warning: a title line with Arrange at its right, and the closest pair heimdall would refuse
// as one row that selects it on the plate (a "+N" when more fail). A tall object the gantry or the lid would hit takes
// the row when no pair fails. A pair heimdall slices as a close call (a measured head that clears it) gets a calm note
// of one line instead, with Arrange still offered, when nothing on the plate fails. While its objects are the selection
// the row reads as pressed, so a phone, which has no panel to name the selection, says what the view outlines.
import { Button, tipAttrs } from '@slicerx/ui'
import { arrangePlate } from '../../plate/edit'
import { pickParts } from '../../plate/pick-parts'
import type { ClearancePlan } from '../../plate/sequence-check'
import { toast, useApp } from '../../state/store'

const mm = (v: number) => (v < 10 ? v.toFixed(1) : Math.round(v).toString())
/** A value and its unit, kept on one line. */
const MM = '\u00a0mm'

type Pair = ClearancePlan['pairs'][number]

/** The objects of the warning's row: the closest pair it names, else the tall one, else the closest close call. */
function rowIds(plan: ClearancePlan): string[] {
  const pair = closest(blocking(plan)) ?? (plan.tall[0] ? undefined : closest(closeCalls(plan)))
  return pair ? [pair.a.id, pair.b.id] : plan.tall[0] ? [plan.tall[0].id] : []
}

/**
 * Selects the objects of the warning's row, the first one primary, and frames them when some of them are off screen.
 * Their clearance zones ring them, so they get no ring of their own.
 */
export function selectClearance(plan: ClearancePlan): string[] {
  const ids = rowIds(plan)
  return ids.length ? pickParts(ids, { ring: false }) : []
}

const blocking = (plan: ClearancePlan) => plan.pairs.filter((p) => p.severity === 'block')
const closeCalls = (plan: ClearancePlan) => plan.pairs.filter((p) => p.severity === 'soft')

function closest(pairs: readonly Pair[]): Pair | undefined {
  return pairs.reduce<Pair | undefined>((best, p) => (!best || p.gapMm < best.gapMm ? p : best), undefined)
}

export function ClearanceWarning({ plan }: { plan: ClearancePlan }) {
  const fails = blocking(plan)
  const pair = closest(fails)
  const tall = plan.tall[0]
  const ids = rowIds(plan)
  const picked = useApp((s) => s.selectedIds.length === ids.length && ids.every((id) => s.selectedIds.includes(id)))
  const arrange = () => void arrangePlate('all').catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'))
  const arrangeButton = (
    <Button size="sm" variant="ghost" data-testid="slice-clearance-arrange" {...tipAttrs({ title: 'Arrange', body: `Lays the plate out with ${Math.round(plan.needMm)} mm between objects, so the toolhead clears them.` })} onClick={arrange}>
      Arrange
    </Button>
  )
  if (!pair && !tall) {
    const calls = closeCalls(plan)
    const near = closest(calls)
    if (!near) return null
    return (
      <div className="seq-card" data-tone="soft" role="status" data-testid="slice-clearance-warning">
        <div className="seq-card-head">
          <span className="seq-dot" aria-hidden="true" />
          <button type="button" className="seq-card-line seq-card-note" data-testid="slice-clearance-select" aria-pressed={picked} {...tipAttrs({ title: 'Select both', body: 'Select on the plate to move them.' })} onClick={() => selectClearance(plan)}>
            <span className="seq-card-name">{`${near.a.name} and ${near.b.name} are close (${mm(near.gapMm)} of ${Math.round(plan.needMm)}${MM}). Check them before you print.`}</span>
            {calls.length > 1 ? <span className="seq-card-more">+{calls.length - 1}</span> : null}
          </button>
          {arrangeButton}
        </div>
      </div>
    )
  }
  const more = Math.max(0, fails.length - 1) + (pair ? plan.tall.length : Math.max(0, plan.tall.length - 1))
  return (
    <div className="seq-card" role="status" data-testid="slice-clearance-warning">
      <div className="seq-card-head">
        <span className="seq-dot" aria-hidden="true" />
        <span className="seq-card-title">{pair ? 'Too close to print by object' : 'Too tall to print first'}</span>
        {arrangeButton}
      </div>
      <button type="button" className="seq-card-line" data-testid="slice-clearance-select" aria-pressed={picked} {...tipAttrs({ title: pair ? 'Select both' : 'Select it', body: 'Select on the plate to move it.' })} onClick={() => selectClearance(plan)}>
        <span className="seq-card-name">{pair ? `${pair.a.name} and ${pair.b.name}` : tall!.name}</span>
        <span className="seq-card-fig">{pair ? `${mm(pair.gapMm)} of ${Math.round(plan.needMm)}${MM}` : `${mm(tall!.topMm)} of ${Math.round(tall!.limitMm)}${MM}`}</span>
        {more > 0 ? <span className="seq-card-more">+{more}</span> : null}
      </button>
    </div>
  )
}
