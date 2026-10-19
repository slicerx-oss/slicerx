// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plan card: what mimir means to build, flat in the conversation. Each feature with the sizes that drive it, the
// overall size and holes when it knows them, what it assumed and what it still needs to know. While the plan waits,
// sizes are fields the person types into; Go approves it with those edits, Not yet sends mimir back to ask. The buttons
// keep their places and the status keeps its height once answered, so nothing moves under the chat.
import type { ChoiceCardProps } from '@slicerx/pilot/ui'
import { Button, Icon, ScrubNumber } from '@slicerx/ui'
import { useState, type ReactNode } from 'react'
import { editPlan, PLAN_CHANGE, PLAN_GO, PLAN_SIZE_MAX, planById, planChoiceId, planOfChoices, samePlan, shownPlan, type PartPlan } from './plan-tool'

/** A size's key in plain words: "wall_thickness" and "wallThickness" read "Wall thickness". */
export function plainLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase()
  return words ? words[0]!.toUpperCase() + words.slice(1) : key
}

const UNIT_WORD = { mm: 'millimeters', in: 'inches' } as const
/** The smallest size a field takes: one step of its last digit, so a size is always more than 0. */
const SIZE_MIN = { mm: 0.01, in: 0.001 } as const

/** Where a size sits in the plan, for editing it. */
type SizeAt = { kind: 'feature'; index: number; key: string } | { kind: 'overall'; axis: 'x' | 'y' | 'z' } | { kind: 'hole'; index: number }

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
}

export function PlanCard({ askId, plan: given, shown = given, picked, actionable, onChoose }: PlanCardProps) {
  const [plan, setPlan] = useState(given)
  const [sent, setSent] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const chosen = picked ?? sent
  const live = chosen === null && actionable && onChoose !== undefined
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

  const answer = (id: string): void => {
    if (!live) return
    if (id === go) editPlan(plan.planId, plan)
    setNote(null)
    setSent(id)
    onChoose(askId, id).catch((e: unknown) => {
      setSent(null)
      setNote(`Could not send your answer: ${e instanceof Error ? e.message : String(e)}`)
    })
  }

  // `group` names where the size sits (the feature, Overall), so two rows called Height read apart to a screen reader
  const row = (id: string, label: string, value: number, at: SizeAt, group: string): ReactNode => (
    <li key={id} className="sheet-rec-row plan-rec-row">
      <label className="sheet-rec-label" htmlFor={live ? id : undefined}>
        {label}
      </label>
      {live ? (
        <span className="sheet-rec-field">
          <ScrubNumber id={id} value={value} ariaLabel={`${group}, ${label}, ${UNIT_WORD[unit]}`} digits={unit === 'in' ? 3 : 2} step={unit === 'in' ? 0.05 : 0.5} min={SIZE_MIN[unit]} max={PLAN_SIZE_MAX} boxed={false} onCommit={(v) => edit(at, v)} />
          <span className="sheet-rec-unit">{unit}</span>
        </span>
      ) : (
        <span className="sheet-rec-v plan-rec-v">
          {value} {unit}
        </span>
      )}
    </li>
  )

  const status = chosen === null ? (actionable ? (edits ? 'Your changes go with Go' : 'Waiting for your go') : 'No answer') : chosen === go ? (edits ? 'Approved with your changes' : 'Approved as shown') : 'Not approved, nothing built'
  const base = `plan-${plan.planId}`

  return (
    <div className="lookup-rec sheet-rec plan-rec" role="group" aria-label={`Plan for ${plan.part}`} data-testid="mimir-plan-card" data-plan-id={plan.planId} data-picked={chosen ?? undefined}>
      <div className="sheet-rec-head">
        <span className="lookup-rec-t">
          <Icon name="list" />
          <span>Plan: {plan.part}</span>
        </span>
        <span className="plan-rec-units">Sizes in {UNIT_WORD[unit]}</span>
      </div>
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
            {Object.keys(f.sizes).length ? <ul className="sheet-rec-rows">{Object.entries(f.sizes).map(([k, v]) => row(`${base}-f${i}-${k}`, plainLabel(k), v, { kind: 'feature', index: i, key: k }, f.name))}</ul> : null}
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
          <ul className="sheet-rec-rows">{plan.holes.map((h, i) => row(`${base}-h${i}`, `${h.name}, diameter`, h.diameter, { kind: 'hole', index: i }, 'Holes'))}</ul>
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
        <span className="lookup-rec-s" data-testid="mimir-plan-status" aria-live="polite">
          {chosen === go ? <Icon name="check" size={14} /> : null}
          {status}
        </span>
        {actionable ? (
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
  return <PlanCard key={props.askId} askId={props.askId} plan={plan} shown={shownPlan(planId) ?? plan} picked={props.picked} actionable={props.actionable} onChoose={props.onChoose} />
}
