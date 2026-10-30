// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The by-object clearance warning: a title line, the closest pair heimdall would refuse as one flat row that selects it
// on the plate (a "+N" when more fail), and Arrange with any fixes as a row of buttons under it. A tall object the gantry or the lid would hit takes
// the row when no pair fails. A pair heimdall slices as a close call (a measured head that clears it) gets a calm note
// of one line instead, with Arrange still offered, when nothing on the plate fails. While its objects are the selection
// the row reads as pressed, so a phone, which has no panel to name the selection, says what the view outlines.
//
// Where the host has an engine (the desktop), its plate check replaces that footprint rule once it has answered for
// the plate as it sits (plate/engine-check.ts): a strike the slice is sure to refuse reads in the engine's words with
// Arrange and the one-click fixes, a strike only the slice can tell gets a muted line, a close call shows nothing, and
// what only the slice checks gets a quiet line when another object is near. None of it holds Print back.
import type { ReactNode } from 'react'
import type { CollisionFix, PlateCheck, UncheckedKind } from '@slicerx/contracts'
import { Button, tipAttrs } from '@slicerx/ui'
import { arrangePlate } from '../../plate/edit'
import { checkFixes, checkRows, type CheckPair } from '../../plate/engine-check'
import { applyPlateCheckFix } from '../../plate/heimdall-fix'
import { collisionTitle, fixTitle, wordsOf } from '../../plate/heimdall-words'
import { pickParts } from '../../plate/pick-parts'
import type { ClearancePlan } from '../../plate/sequence-check'
import { toast, useApp } from '../../state/store'

const mm = (v: number) => (v < 10 ? v.toFixed(1) : Math.round(v).toString())
/** A value and its unit, kept on one line. */
const MM = ' mm'

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

function ArrangeButton({ needMm }: { needMm: number | null }) {
  const arrange = () => void arrangePlate('all').catch((e: unknown) => toast(e instanceof Error ? e.message : String(e), 'error'))
  const body = needMm !== null ? `Lays the plate out with ${Math.round(needMm)} mm between objects, so the toolhead clears them.` : 'Lays the plate out so the toolhead clears every object.'
  return (
    <Button size="sm" data-testid="slice-clearance-arrange" {...tipAttrs({ title: 'Arrange', body })} onClick={arrange}>
      Arrange
    </Button>
  )
}

/** The muted line under the warning while the engine's check takes a moment. */
function Checking() {
  return (
    <p className="seq-card-muted" data-testid="slice-clearance-checking">
      Checking
    </p>
  )
}

/** The warning's buttons, side by side under its rows. */
function Actions({ children }: { children: ReactNode }) {
  return <div className="seq-card-actions">{children}</div>
}

/** The footprint rule's warning. `checking`: the engine's check has been running a moment. */
export function ClearanceWarning({ plan, checking = false }: { plan: ClearancePlan; checking?: boolean }) {
  const fails = blocking(plan)
  const pair = closest(fails)
  const tall = plan.tall[0]
  const ids = rowIds(plan)
  const picked = useApp((s) => s.selectedIds.length === ids.length && ids.every((id) => s.selectedIds.includes(id)))
  if (!pair && !tall) {
    const calls = closeCalls(plan)
    const near = closest(calls)
    if (!near) return null
    return (
      <div className="seq-card" data-tone="soft" role="status" data-testid="slice-clearance-warning">
        <div className="seq-card-head">
          <span className="seq-dot" aria-hidden="true" />
          <button type="button" className="seq-card-row seq-card-note" data-testid="slice-clearance-select" aria-pressed={picked} {...tipAttrs({ title: 'Select both', body: 'Select on the plate to move them.' })} onClick={() => selectClearance(plan)}>
            <span className="seq-card-name">{`${near.a.name} and ${near.b.name} are close (${mm(near.gapMm)} of ${Math.round(plan.needMm)}${MM}). Check them before you print.`}</span>
            {calls.length > 1 ? <span className="seq-card-more">+{calls.length - 1}</span> : null}
          </button>
        </div>
        <Actions>
          <ArrangeButton needMm={plan.needMm} />
        </Actions>
        {checking ? <Checking /> : null}
      </div>
    )
  }
  const more = Math.max(0, fails.length - 1) + (pair ? plan.tall.length : Math.max(0, plan.tall.length - 1))
  return (
    <div className="seq-card" role="status" data-testid="slice-clearance-warning">
      <div className="seq-card-head">
        <span className="seq-dot" aria-hidden="true" />
        <span className="seq-card-title">{pair ? 'Too close to print by object' : 'Too tall to print first'}</span>
      </div>
      <button type="button" className="seq-card-row" data-testid="slice-clearance-select" aria-pressed={picked} {...tipAttrs({ title: pair ? 'Select both' : 'Select it', body: 'Select on the plate to move it.' })} onClick={() => selectClearance(plan)}>
        <span className="seq-card-name">{pair ? `${pair.a.name} and ${pair.b.name}` : tall!.name}</span>
        <span className="seq-card-fig">{pair ? `${mm(pair.gapMm)} of ${Math.round(plan.needMm)}${MM}` : `${mm(tall!.topMm)} of ${Math.round(tall!.limitMm)}${MM}`}</span>
        {more > 0 ? <span className="seq-card-more">+{more}</span> : null}
      </button>
      <Actions>
        <ArrangeButton needMm={plan.needMm} />
      </Actions>
      {checking ? <Checking /> : null}
    </div>
  )
}

/** What the slice checks that the plate check leaves to it, one quiet line each. */
const LEFT_TO_SLICE: Record<UncheckedKind, string> = {
  tool_change_trips: 'Tool changes: checked when you slice.',
  tree_support: 'Tree supports: checked when you slice.',
  raft: 'Raft: checked when you slice.',
  painted_brim: 'Brim ears: checked when you slice.',
}

function LeftToSlice({ kinds }: { kinds: readonly UncheckedKind[] }) {
  return (
    <>
      {kinds.map((k) => (
        <p key={k} className="seq-card-muted" data-testid="slice-clearance-unchecked">
          {LEFT_TO_SLICE[k]}
        </p>
      ))}
    </>
  )
}

/** The pair row, flat: both names, a "+N" for the pairs it leaves out, pressed while they are the selection. */
function PairRow({ pair, more, note, names }: { pair: CheckPair; more: number; note: boolean; names: (id: string) => string }) {
  const ids = [pair.a, pair.b]
  const picked = useApp((s) => s.selectedIds.length === 2 && ids.every((id) => s.selectedIds.includes(id)))
  return (
    <button type="button" className={note ? 'seq-card-row seq-card-note' : 'seq-card-row'} data-testid="slice-clearance-select" aria-pressed={picked} {...tipAttrs({ title: 'Select both', body: 'Select on the plate to move them.' })} onClick={() => pickParts(ids, { ring: false })}>
      <span className="seq-card-name">{`${names(pair.a)} and ${names(pair.b)}`}</span>
      {more > 0 ? <span className="seq-card-more">+{more}</span> : null}
    </button>
  )
}

const FIX_IDS: Partial<Record<CollisionFix['kind'], string>> = { reorder: 'slice-clearance-fix-reorder', by_layer: 'slice-clearance-fix-by-layer' }

/** The engine's plate check as the warning. Null when it has nothing to say (a close call only, or nothing). */
export function EngineWarning({ check, needMm = null }: { check: PlateCheck; needMm?: number | null }) {
  const plate = useApp((s) => s.plate)
  const profile = useApp((s) => s.profile)
  const { name, station } = wordsOf({ plate, profile })
  const rows = checkRows(check)
  const sure = rows.sure[0]
  if (sure) {
    const fixes = checkFixes(check)
    const first = check.collisions[sure.collisions[0]!]!
    const order = plate.filter((p) => p.printable !== false).map((p) => p.id)
    return (
      <div className="seq-card" role="status" data-testid="slice-clearance-warning" data-verdict="sure">
        <div className="seq-card-head">
          <span className="seq-dot" aria-hidden="true" />
          <span className="seq-card-title">{collisionTitle(first, name, station)}</span>
        </div>
        <PairRow pair={sure} more={rows.sure.length - 1} note={false} names={name} />
        <Actions>
          <ArrangeButton needMm={needMm} />
          {fixes.map((f) => (
            <Button key={f.kind} size="sm" data-testid={FIX_IDS[f.kind]} onClick={() => applyPlateCheckFix(f)}>
              {fixTitle(f, name, order, station, check.collisions)}
            </Button>
          ))}
        </Actions>
        <LeftToSlice kinds={rows.unchecked} />
      </div>
    )
  }
  const decides = rows.decides[0]
  if (decides) {
    return (
      <div className="seq-card" data-tone="soft" role="status" data-testid="slice-clearance-warning" data-verdict="slice-decides">
        <div className="seq-card-head">
          <span className="seq-dot" aria-hidden="true" />
          <PairRow pair={decides} more={rows.decides.length - 1} note names={name} />
        </div>
        <p className="seq-card-muted" data-testid="slice-clearance-decides">
          May clash. Slice to check.
        </p>
        <Actions>
          <ArrangeButton needMm={needMm} />
        </Actions>
        <LeftToSlice kinds={rows.unchecked} />
      </div>
    )
  }
  if (rows.unchecked.length === 0) return null
  return (
    <div className="seq-card" data-tone="quiet" role="status">
      <LeftToSlice kinds={rows.unchecked} />
    </div>
  )
}

/**
 * The warning before a current slice: the engine's answer once it has one for the plate as it sits, else the footprint
 * rule's plan (with "Checking" once the engine has taken a moment).
 */
export function PreflightWarning({ plan, check, checking }: { plan: ClearancePlan | null; check: PlateCheck | null; checking: boolean }) {
  if (check) return <EngineWarning check={check} needMm={plan?.needMm ?? null} />
  return plan ? <ClearanceWarning plan={plan} checking={checking} /> : null
}
