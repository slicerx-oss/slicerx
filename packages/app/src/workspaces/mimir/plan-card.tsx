// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plan card: what mimir means to build, flat in the conversation. Each feature with the sizes that drive it, the
// overall size and holes when it knows them, what it assumed and what it still needs to know. While the plan waits,
// sizes are fields the person types into; Go approves it with those edits, Not yet sends mimir back to ask. The buttons
// keep their places and the status keeps its height once answered, so nothing moves under the chat. A plan at its
// default size that went ahead with nobody asked (auto) shows as approved with no buttons, and one line saying how to
// change it after. A count among a
// feature's sizes shows with no unit and an angle in degrees, in an inch plan too: by the kind the plan gives it, else
// by its name (kindOf).
import { kindOf, sizeLabelKey, sizeText, sizeUnit, wholeCount, type SizeKind } from '@slicerx/contracts/size-kind'
import { ASSISTANT_NAME } from '@slicerx/pilot/name'
import type { ChoiceCardProps } from '@slicerx/pilot/ui'
import { Button, Icon, Seg } from '@slicerx/ui'
import { ScrubNumber } from '@slicerx/ui/scrub'
import { useState, type ReactNode } from 'react'
import { DETAIL_LABEL, DETAIL_LEVELS, DETAIL_LINE, type DetailLevel, amendOf, editPlan, PLAN_CHANGE, PLAN_GO, PLAN_SIZE_MAX, planById, planChoiceId, planOfChoices, samePlan, shownPlan, type PartPlan } from './plan-tool'

/** A size's key in plain words: "wall_thickness" and "wallThickness" read "Wall thickness". */
export function plainLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase()
  return words ? words[0]!.toUpperCase() + words.slice(1) : key
}

/** The line an approved-at-once plan card shows in place of its buttons. */
export const PLAN_AUTO_LINE = 'Built at its default size; ask to resize or change it.'

/** What the card says when its answer could not be delivered. */
export const PLAN_INACTIVE = `Nothing built. Ask ${ASSISTANT_NAME} again.`

const UNIT_WORD = { mm: 'millimeters', in: 'inches' } as const
/** The smallest size a field takes: one step of its last digit, so a size is always more than 0. */
const SIZE_MIN = { mm: 0.01, in: 0.001 } as const

/** The decimals a value has of its own, up to 4: 0 for 7, 1 for 7.5, 3 for 7.555. */
function ownDigits(value: number): number {
  for (let d = 0; d < 4; d++) if (Number(value.toFixed(d)) === value) return d
  return 4
}

/** How a size's field reads and steps: a count in whole steps with no unit (its own decimals when the plan gave a fraction), an angle in degrees, a length in the plan's units. */
function fieldOf(kind: SizeKind, unit: 'mm' | 'in', value: number): { unit: string; word: string; digits: number; step: number; min: number } {
  // a fraction that came in the plan shows its own decimals (up to 4), so the field reads what Go sends
  if (kind === 'count') return { unit: sizeUnit(kind, unit), word: '', digits: ownDigits(value), step: 1, min: 1 }
  if (kind === 'angle') return { unit: sizeUnit(kind, unit), word: 'degrees', digits: 2, step: 1, min: SIZE_MIN.mm }
  return { unit: sizeUnit(kind, unit), word: UNIT_WORD[unit], digits: unit === 'in' ? 3 : 2, step: unit === 'in' ? 0.05 : 0.5, min: SIZE_MIN[unit] }
}

/** Where a size sits in the plan, for editing it. */
type SizeAt = { kind: 'feature'; index: number; key: string } | { kind: 'overall'; axis: 'x' | 'y' | 'z' } | { kind: 'hole'; index: number }

/** The size at `at` in a plan, or undefined when it has none there. */
function sizeAt(plan: PartPlan, at: SizeAt): number | undefined {
  if (at.kind === 'feature') return plan.features[at.index]?.sizes[at.key]
  if (at.kind === 'overall') return plan.overall?.[at.axis]
  return plan.holes?.[at.index]?.diameter
}

function withSize(plan: PartPlan, at: SizeAt, value: number): PartPlan {
  if (at.kind === 'feature') return { ...plan, features: plan.features.map((f, i) => (i === at.index ? { ...f, sizes: { ...f.sizes, [at.key]: value } } : f)) }
  if (at.kind === 'overall') return plan.overall ? { ...plan, overall: { ...plan.overall, [at.axis]: value } } : plan
  return plan.holes ? { ...plan, holes: plan.holes.map((h, i) => (i === at.index ? { ...h, diameter: value } : h)) } : plan
}

const OVERALL: { axis: 'x' | 'y' | 'z'; label: string }[] = [
  { axis: 'x', label: 'Width' },
  { axis: 'y', label: 'Depth' },
  { axis: 'z', label: 'Height' },
]

export interface PlanCardProps {
  askId: string
  /** The plan as last edited. */
  plan: PartPlan
  /** The plan as mimir showed it; the card marks what differs. Defaults to `plan`. */
  shown?: PartPlan | undefined
  /** The answer the run recorded, or null while the plan waits. */
  picked: string | null
  /** False for a card from a saved log: it cannot be answered. */
  actionable: boolean
  onChoose?: ((askId: string, choiceId: string) => Promise<void>) | undefined
  /** The person wrote in the message box instead of answering, which turns the plan down. */
  dismissed?: boolean | undefined
  /**
   * For a change the build asks to make to an approved plan: that plan as approved, whose sizes show beside the new
   * ones, and the build's reason.
   */
  amend?: { was: PartPlan; why: string } | undefined
  /** It was approved as shown at once, with nobody asked: the build went ahead at its default size. */
  auto?: boolean | undefined
}

export function PlanCard({ askId, plan: given, shown = given, picked, actionable, onChoose, dismissed = false, amend, auto = false }: PlanCardProps) {
  const [plan, setPlan] = useState(given)
  const [sent, setSent] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // an answer the app could not deliver: the plan's question is gone, so the card stops taking answers and edits
  const [inactive, setInactive] = useState(false)
  const chosen = picked ?? sent
  const live = chosen === null && actionable && onChoose !== undefined && !inactive
  const go = planChoiceId(PLAN_GO, plan.planId)
  const edits = !samePlan(plan, shown)
  const unit = plan.units

  const edit = (at: SizeAt, value: number): void => {
    const next = withSize(plan, at, value)
    // the card only shows what the plan kept; a size the plan turns down leaves the field as it was
    if (editPlan(next.planId, next)) {
      setPlan(next)
      setNote(null)
    } else setNote(`That size was not kept. Sizes are more than 0 and up to ${PLAN_SIZE_MAX} ${unit}.`)
  }

  // the detail level the plan was made at, which the person can change on the card before Go: mimir builds to it
  const setDetail = (detail: DetailLevel): void => {
    const next = { ...plan, detail }
    if (editPlan(next.planId, next)) setPlan(next)
  }

  const answer = (id: string): void => {
    if (!live) return
    if (id === go) editPlan(plan.planId, plan)
    setNote(null)
    setSent(id)
    // no internal reason or id reaches the person: the plan is over, and asking again makes a new one
    onChoose(askId, id).catch((e: unknown) => {
      console.warn('mimir: the plan answer did not land', e)
      setSent(null)
      setInactive(true)
    })
  }

  // `group` names where the size sits (the feature, Overall), so two rows called Height read apart to a screen reader
  // `times` is how many holes a hole row stands for: more than one reads "4 x 3.4 mm"
  // `kind` is what the size measures: a count reads "4", an angle "30°", a length "80 mm"; a count typed as a fraction is kept whole
  const row = (id: string, label: string, value: number, at: SizeAt, group: string, times = 1, kind: SizeKind = 'length'): ReactNode => {
    const f = fieldOf(kind, unit, value)
    // a size the build asks to change reads the approved value beside it, in the tag the sheet's record uses for a change
    const was = amend ? sizeAt(amend.was, at) : undefined
    return (
      <li key={id} className="sheet-rec-row plan-rec-row">
        <label className="sheet-rec-label" htmlFor={live ? id : undefined}>
          {label}
          {was !== undefined && was !== value ? (
            <small className="sheet-rec-tag" data-testid="mimir-plan-was">
              was {times > 1 ? `${times} x ` : ''}
              {sizeText(kind, was, unit)}
            </small>
          ) : null}
        </label>
        {live ? (
          <span className="sheet-rec-field">
            {times > 1 ? <span className="sheet-rec-unit">{times} x</span> : null}
            <ScrubNumber id={id} value={value} ariaLabel={`${group}, ${label}${times > 1 ? `, ${times} holes` : ''}${f.word ? `, ${f.word}` : ''}`} digits={f.digits} step={f.step} min={f.min} max={PLAN_SIZE_MAX} boxed={false} onCommit={(v) => edit(at, kind === 'count' ? wholeCount(v) : v)} />
            {f.unit ? <span className="sheet-rec-unit">{f.unit}</span> : null}
          </span>
        ) : (
          <span className="sheet-rec-v plan-rec-v">
            {times > 1 ? `${times} x ` : ''}
            {sizeText(kind, value, unit)}
          </span>
        )}
      </li>
    )
  }

  const waiting = edits ? 'Your changes go with Go' : amend ? 'Waiting for your go on the change' : 'Waiting for your go'
  const approved = amend ? (edits ? 'Plan changed with your changes' : 'Plan changed') : edits ? 'Approved with your changes' : 'Approved as shown'
  const declined = amend ? 'Not changed, the plan stays as approved' : 'Not approved, nothing built'
  const status = dismissed ? 'Canceled' : chosen === null ? (inactive ? PLAN_INACTIVE : actionable ? waiting : 'No answer') : chosen === go ? approved : declined
  const base = `plan-${plan.planId}`

  return (
    <div className="lookup-rec sheet-rec plan-rec" role="group" aria-label={`${amend ? 'Plan change' : 'Plan'} for ${plan.part}`} data-testid="mimir-plan-card" data-plan-id={plan.planId} data-amends={amend?.was.planId} data-picked={chosen ?? undefined} data-auto={auto || undefined}>
      <div className="sheet-rec-head">
        <span className="lookup-rec-t">
          <Icon name="list" />
          <span>
            {amend ? 'Plan change' : 'Plan'}: {plan.part}
          </span>
        </span>
        <span className="plan-rec-units">Sizes in {UNIT_WORD[unit]}</span>
      </div>
      {amend ? (
        <section className="plan-rec-block" aria-label="Why the plan changes">
          <span className="plan-rec-h">{ASSISTANT_NAME} asks to change the approved plan</span>
          <ul className="plan-rec-notes">
            <li data-testid="mimir-plan-why">{amend.why}</li>
          </ul>
        </section>
      ) : null}
      {plan.detail ? (
        <section className="plan-rec-block plan-rec-detail" aria-label="Detail" data-testid="mimir-plan-detail" data-detail={plan.detail}>
          <span className="plan-rec-h">Detail</span>
          {live && !amend ? (
            <Seg label="Detail" size="sm" value={plan.detail} onChange={setDetail} options={DETAIL_LEVELS.map((d) => ({ value: d, label: DETAIL_LABEL[d], testId: `mimir-plan-detail-${d}` }))} />
          ) : (
            <span className="sheet-rec-v plan-rec-v">{DETAIL_LABEL[plan.detail]}</span>
          )}
          <small className="plan-rec-detail-line">{DETAIL_LINE[plan.detail]}</small>
        </section>
      ) : null}
      <ol className="plan-rec-features">
        {plan.features.map((f, i) => (
          <li key={`${i}-${f.name}`} className="plan-rec-feature" data-testid="mimir-plan-feature">
            <span className="plan-rec-name">
              <span className="plan-rec-n" aria-hidden="true">
                {i + 1}
              </span>
              <span>{f.name}</span>
              {f.kind ? <small className="sheet-rec-tag">{plainLabel(f.kind).toLowerCase()}</small> : null}
            </span>
            {Object.keys(f.sizes).length ? <ul className="sheet-rec-rows">{Object.entries(f.sizes).map(([k, v]) => row(`${base}-f${i}-${k}`, plainLabel(sizeLabelKey(k, kindOf(k, f.kinds?.[k]))), v, { kind: 'feature', index: i, key: k }, f.name, 1, kindOf(k, f.kinds?.[k])))}</ul> : null}
          </li>
        ))}
      </ol>
      {plan.overall ? (
        <section className="plan-rec-block" aria-label="Overall size">
          <span className="plan-rec-h">Overall</span>
          <ul className="sheet-rec-rows">{OVERALL.map((o) => row(`${base}-o${o.axis}`, o.label, plan.overall![o.axis], { kind: 'overall', axis: o.axis }, 'Overall'))}</ul>
        </section>
      ) : null}
      {plan.holes?.length ? (
        <section className="plan-rec-block" aria-label="Holes">
          <span className="plan-rec-h">Holes</span>
          <ul className="sheet-rec-rows">{plan.holes.map((h, i) => row(`${base}-h${i}`, `${h.name}, diameter`, h.diameter, { kind: 'hole', index: i }, 'Holes', h.count))}</ul>
        </section>
      ) : null}
      {plan.assumptions.length ? (
        <section className="plan-rec-block" aria-label="Assumed">
          <span className="plan-rec-h">Assumed</span>
          <ul className="plan-rec-notes">
            {plan.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {plan.questions.length ? (
        <section className="plan-rec-block" aria-label="Still to settle">
          <span className="plan-rec-h">Still to settle</span>
          <ul className="plan-rec-notes">
            {plan.questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </section>
      ) : null}
      <span className="sheet-rec-foot plan-rec-foot">
        <span className="lookup-rec-s" data-testid="mimir-plan-status" role="status">
          {chosen === go ? <Icon name="check" size={14} /> : null}
          {status}
        </span>
        {auto && chosen === go ? (
          <small className="plan-rec-auto" data-testid="mimir-plan-auto">
            {PLAN_AUTO_LINE}
          </small>
        ) : actionable ? (
          <>
            <Button size="sm" variant="ghost" disabled={!live} data-testid="mimir-plan-change" onClick={() => answer(planChoiceId(PLAN_CHANGE, plan.planId))}>
              Not yet
            </Button>
            <Button size="sm" variant="primary" disabled={!live} data-testid="mimir-plan-go" onClick={() => answer(go)}>
              Go
            </Button>
          </>
        ) : null}
      </span>
      {note ? <span className="choice-note">{note}</span> : null}
    </div>
  )
}

/** A plan card in place of the choice card, for a question that is a plan this window made; otherwise null. */
export function planChoiceCard(props: ChoiceCardProps): ReactNode {
  const planId = planOfChoices(props.choices)
  const plan = planId ? planById(planId) : null
  if (!planId || !plan) return null
  const amend = amendOf(planId)
  return <PlanCard key={props.askId} askId={props.askId} plan={plan} shown={shownPlan(planId) ?? plan} picked={props.picked} actionable={props.actionable} onChoose={props.onChoose} dismissed={props.dismissed} amend={amend ? { was: amend.was, why: amend.why } : undefined} auto={props.auto} />
}
