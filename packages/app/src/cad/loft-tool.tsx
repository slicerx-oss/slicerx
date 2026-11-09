// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The loft tool: click finished sketches in the view or the tree, in order, and a solid runs through them, straight or
// smooth, closed back to the first as a ring when asked. Each sketch is one closed loop. The step keeps its own copy of
// the loops, and the sketches it was made from hide while it is live. Editing the step fills the panel from it, each
// profile matched back to the sketch it came from where that sketch is still the same.
import { Button } from '@slicerx/ui'
import { loftParams, type LoftProfile } from '@slicerx/cad-history'
import { useMemo, useState } from 'react'
import { useHost } from '../host'
import { set, toast } from '../state/store'
import { applyLoft } from './cad-ops'
import { editing, saveStep } from './history/ops'
import { editingNumber } from './history/step-number'
import { keptWords, loftReason, matchSketch, movePick, profileOf, removePick, ringReason } from './loft-sweep'
import { Choice, errorText, Message, Note, PointerHint, Row, Shell, ToolFooter, type ChoiceOption } from './panel-kit'
import { useDraft } from './park'
import { sizeWords } from './op-preview'
import { frameShown } from './sketch-place'
import { profileNow, ResultChoice, useLiveSketches, useResult, useSketchPicks, type Result } from './solid-kit'

/** A row of the profiles list: a picked sketch, or a profile the step keeps that matches no sketch now. */
export type LoftRow = { id: string } | { kept: LoftProfile; n: number }

type Sides = 'straight' | 'smooth'
const SIDES: readonly ChoiceOption<Sides>[] = [
  { value: 'straight', label: 'Straight', tip: { title: 'Straight', body: 'Flat sides from each profile to the next.' }, testId: 'loft-sides-straight' },
  { value: 'smooth', label: 'Smooth', tip: { title: 'Smooth', body: 'One curved side through every profile.' }, testId: 'loft-sides-smooth' },
]

export function LoftTool() {
  const host = useHost()
  const sketches = useLiveSketches()
  const edit = (() => {
    const ed = editing()
    const p = ed?.step.params
    return ed && p?.op === 'sketch.loft' ? { index: ed.index, step: ed.step, entry: ed.entry, params: p, target: { objectId: ed.entry.id, partIndex: Math.max(0, ed.step.part) }, operation: (p.operation ?? 'new') as Result } : null
  })()
  const [rows, setRows] = useDraft<LoftRow[]>('rows', () => {
    if (!edit) return []
    const taken = new Set<string>()
    return edit.params.profiles.map((p, i): LoftRow => {
      const now = profileNow(p, edit.step, edit.entry.transform)
      const k = matchSketch(now, sketches.filter((s) => !taken.has(s.id)), frameShown)
      if (k) taken.add(k.id)
      return k ? { id: k.id } : { kept: now, n: i + 1 }
    })
  })
  const [sides, setSides] = useDraft<Sides>('sides', edit?.params.smooth ? 'smooth' : 'straight')
  const [ring, setRing] = useDraft('ring', Boolean(edit?.params.closed))
  const [chosen, setChosen] = useDraft<Result | null>('operation', null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // a picked sketch that left the timeline (deleted, or rolled back) leaves the list
  const byId = useMemo(() => new Map(sketches.map((k) => [k.id, k])), [sketches])
  const live = useMemo(() => rows.filter((r) => !('id' in r) || byId.has(r.id)), [rows, byId])
  const first = live[0] && 'id' in live[0] ? (byId.get(live[0].id) ?? null) : null
  const result = useResult(first, chosen, edit)
  const n = live.length
  const marks = useMemo(() => new Map(live.flatMap((r, i) => ('id' in r ? [[r.id, String(i + 1)] as const] : []))), [live])

  useSketchPicks(marks, (id) => {
    const k = byId.get(id)
    if (!k) return
    setNote(null)
    if (live.some((r) => 'id' in r && r.id === id)) return setRows(live.filter((r) => !('id' in r) || r.id !== id))
    const p = profileOf(k, frameShown(k), 'loft')
    if ('why' in p) return setNote(p.why)
    setRows([...live, { id }])
  })

  const ringOff = ringReason(n)
  const closed = ring && ringOff === null
  const reason = loftReason(n)

  const apply = async () => {
    if (reason !== null || busy) return
    setBusy(true)
    setNote(null)
    try {
      const profiles = live.map((r) => {
        if (!('id' in r)) return r.kept
        const k = byId.get(r.id)!
        const p = profileOf(k, frameShown(k), 'loft')
        if ('why' in p) throw new Error(p.why)
        return p.profile
      })
      const uses = live.flatMap((r) => ('id' in r ? [r.id] : []))
      const into = result.op !== 'new' && result.target ? { target: result.target } : {}
      const input = { profiles, smooth: sides === 'smooth', closed, operation: result.op, ...into, name: edit?.params.name ?? 'Loft body' }
      if (edit) {
        const said = await saveStep(host.slicer, loftParams(input), { uses })
        toast(said.message, said.warn ? 'warn' : 'ok')
        set({ objectTool: null })
        return
      }
      const r = await applyLoft(host.slicer, input, { uses })
      if (r.missed) return setNote(r.message)
      toast(r.message, r.warn ? 'warn' : 'ok')
      return true
    } catch (e) {
      setNote(sizeWords(errorText(e)))
    } finally {
      setBusy(false)
    }
  }

  const nameOf = (r: LoftRow) => ('id' in r ? (byId.get(r.id)?.name ?? 'A sketch') : keptWords(r.n))
  return (
    <Shell title="Loft" aside={edit ? `Editing step ${editingNumber(edit.index)}` : n ? `${n} profile${n === 1 ? '' : 's'}` : 'Nothing picked yet'}>
      <PointerHint text="Click sketches in the view or the tree, in order." />
      <ResultChoice id="loft-result" value={result.op} onChange={setChosen} options={result.options} canInto={result.canInto} editing={edit !== null} />
      <Choice id="loft-sides" label="Sides" value={sides} onChange={setSides} options={SIDES} />
      <Row label="Closed ring" htmlFor="loft-ring" testId="loft-ring-row">
        <input id="loft-ring" type="checkbox" className="tp-check" data-testid="loft-ring" checked={closed} disabled={ringOff !== null} aria-describedby={ringOff ? 'loft-ring-why' : undefined} onChange={(e) => setRing(e.target.checked)} />
      </Row>
      {ringOff ? (
        <p id="loft-ring-why" className="tp-card-reason" data-testid="loft-ring-reason">
          {ringOff}
        </p>
      ) : null}
      <ProfileList rows={live} nameOf={nameOf} onChange={setRows} />
      {note ? <Message text={note} testId="loft-message" /> : null}
      <ToolFooter verb="Loft" onApply={apply} busy={busy} disabled={reason !== null} reason={reason} />
    </Shell>
  )
}

/** The profiles in loft order, numbered, each with Up, Down and Remove. It grows downward, so nothing above it moves. */
function ProfileList({ rows, nameOf, onChange }: { rows: readonly LoftRow[]; nameOf: (r: LoftRow) => string; onChange: (rows: LoftRow[]) => void }) {
  return (
    <section className="solid-list" aria-labelledby="loft-profiles-label">
      <span className="tp-label" id="loft-profiles-label">
        Profiles
      </span>
      {rows.length ? (
        <ol className="solid-rows" aria-labelledby="loft-profiles-label" data-testid="loft-profiles">
          {rows.map((r, i) => {
            const name = nameOf(r)
            return (
              <li key={'id' in r ? r.id : `kept-${r.n}`} className="solid-row" data-testid="loft-profile" data-kept={'id' in r ? undefined : ''}>
                <span className="cad-pick-n">{i + 1}</span>
                <span className="solid-row-name min0" data-tip-title={name}>
                  {name}
                </span>
                <span className="solid-row-btns">
                  <Button variant="ghost" size="sm" icon="arrow-up" aria-label={`Move ${name} up`} data-testid="loft-profile-up" disabled={i === 0} onClick={() => onChange(movePick(rows, i, -1))} />
                  <Button variant="ghost" size="sm" icon="arrow-down" aria-label={`Move ${name} down`} data-testid="loft-profile-down" disabled={i === rows.length - 1} onClick={() => onChange(movePick(rows, i, 1))} />
                  <Button variant="ghost" size="sm" icon="close" aria-label={`Remove ${name}`} data-testid="loft-profile-remove" onClick={() => onChange(removePick(rows, i))} />
                </span>
              </li>
            )
          })}
        </ol>
      ) : (
        <Note testId="loft-profiles-empty">No sketches picked yet. Each one is a closed loop on its own plane.</Note>
      )}
    </section>
  )
}
