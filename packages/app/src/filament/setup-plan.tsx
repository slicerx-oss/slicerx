// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The settings plan, inline. When the printer, nozzle or filament changes, planSettings (packages/settings/js/plan.ts) works out what
// the new setup needs from the knowledge base: blockers (an abrasive filament on a soft nozzle), warnings, questions and what it moved.
// It shows only when there is something to say, so a normal setup stays quiet: in the line under the filament rail,
// in place of its hint, so the panel keeps its height whether or not the plan has loaded yet.
import type { SettingsPlan, SetupRef } from '@slicerx/contracts'
import { Button, LinkButton, tipAttrs } from '@slicerx/ui'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { dryKey, isDryingNote, pruneMarks, spoolOf, stillDry } from './dry-marks'
import { resolveSlots } from './slots'
import { set, useApp, type AppState } from '../state/store'

const VENDOR: Record<string, string> = { 'bambu lab': 'bambu', 'prusa research': 'prusa', prusa: 'prusa', creality: 'creality', elegoo: 'elegoo', sovol: 'sovol', voron: 'voron' }
const slug = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

/** The knowledge base id for a printer model, or null when the base has no such printer. */
export function knowledgePrinterId(vendor: string, model: string, known: ReadonlySet<string>): string | null {
  const v = VENDOR[vendor.toLowerCase()] ?? slug(vendor)
  const id = `${v}_${slug(model)}`
  return known.has(id) ? id : null
}

/** The knowledge base id for a slot's material ("PLA+" is pla_plus, "PETG-CF" is petg_cf, a bare "TPU" is the common 95A). */
export function knowledgeMaterialId(type: string, known: ReadonlySet<string>): string | null {
  const id = slug(type.replace(/\+/g, ' plus '))
  for (const c of [id, id === 'tpu' ? 'tpu_95a' : '', id.replace(/_?(cf)$/, '_cf')]) if (c && known.has(c)) return c
  return null
}

export interface PlanNotes {
  blockers: string[]
  warnings: string[]
  questions: string[]
  /** Settings the plan moved for the new setup, by label, when the setup just changed. */
  moved: number
  /** The slot whose filament the plan is for (its label, "A1"), and the spool in it, for "It's dry". */
  slot: { label: string; spool: string } | null
}

function key(s: AppState): string {
  const slots = resolveSlots(s).filter((r) => r.used)
  return `${s.printerModel ? `${s.printerModel.vendor}|${s.printerModel.model}` : ''}|${s.printerModel?.id ? (s.nozzleReported[s.printerModel.id] ?? s.printerNozzles[s.printerModel.id] ?? '') : ''}|${slots.map((r) => `${r.type}:${spoolOf(r, r.source === 'printer' ? s.printerSlots[r.index - 1] : undefined)}`).join(',')}`
}

/** The plan notes for the current printer, nozzle and filaments; null while there is nothing to say. */
export function usePlanNotes(): PlanNotes | null {
  const k = useApp(key)
  const [notes, setNotes] = useState<PlanNotes | null>(null)
  const last = useRef<SetupRef | null>(null)
  useEffect(() => {
    let stale = false
    void (async () => {
      const s = (await import('../state/store')).get()
      if (!s.printerModel) return setNotes(null)
      const [{ planSettings, listPrinters, listMaterials }] = await Promise.all([import('@slicerx/settings')])
      const printer = knowledgePrinterId(s.printerModel.vendor, s.printerModel.model, new Set(listPrinters().map((p) => p.id)))
      const used = resolveSlots(s).filter((r) => r.used)
      const mats = new Set(listMaterials().map((m) => m.id))
      const planned = used.find((r) => knowledgeMaterialId(r.type, mats) !== null)
      const filament = planned ? knowledgeMaterialId(planned.type, mats) : null
      if (!printer || !filament || !planned || stale) return setNotes(null)
      const nozzle = (s.printerModel.id ? (s.nozzleReported[s.printerModel.id] ?? s.printerNozzles[s.printerModel.id]) : undefined) ?? s.profile?.nozzle ?? 0.4
      const to: SetupRef = { printer, nozzleDiameter: nozzle, filament }
      const plan: SettingsPlan = planSettings(last.current ?? to, to)
      last.current = to
      if (stale) return
      const slot = { label: planned.label, spool: spoolOf(planned, planned.source === 'printer' ? s.printerSlots[planned.index - 1] : undefined) }
      const out = { blockers: plan.blockers, warnings: plan.warnings, questions: plan.questions, moved: plan.changes.length, slot }
      setNotes(out.blockers.length || out.warnings.length || out.questions.length ? out : null)
    })().catch(() => setNotes(null))
    return () => {
      stale = true
    }
  }, [k])
  return notes
}

/** Marks the slot's spool as dry, which hides the drying note for it until the spool changes or seven days pass. */
export function markDry(printerId: string | null, slot: { label: string; spool: string }, now = Date.now()): void {
  set((s) => ({ dryMarks: { ...pruneMarks(s.dryMarks, now), [dryKey(printerId, slot.label)]: { at: now, spool: slot.spool } } }))
}

export interface NoteRow {
  t: string
  k: 'block' | 'warn' | 'ask'
}

/** The notes to show, blockers first, without the drying note for a spool marked dry; null while there is nothing to say. */
export function useSetupNotes(): { rows: NoteRow[]; slot: PlanNotes['slot']; printerId: string | null } | null {
  const notes = usePlanNotes()
  const printerId = useApp((s) => s.printerId)
  const mark = useApp((s) => (notes?.slot ? s.dryMarks[dryKey(s.printerId, notes.slot.label)] : undefined))
  if (!notes) return null
  const slot = notes.slot
  const dry = slot !== null && stillDry(mark, slot.spool, Date.now())
  const rows: NoteRow[] = [
    ...notes.blockers.map((t) => ({ t, k: 'block' as const })),
    ...notes.warnings.map((t) => ({ t, k: 'warn' as const })),
    ...notes.questions.map((t) => ({ t, k: 'ask' as const })),
  ].filter(({ t }) => !(dry && isDryingNote(t)))
  return rows.length ? { rows, slot, printerId } : null
}

/**
 * The notes in the one line under the filament rail: the first in full width, the rest in its tip. The drying note has
 * "It's dry", which hides it for that spool. `after` stays at the end of the line (Reset to printer).
 */
export function SetupNoteLine({ notes, after }: { notes: NonNullable<ReturnType<typeof useSetupNotes>>; after?: ReactNode }) {
  const { rows, slot, printerId } = notes
  const first = rows[0]!
  return (
    <p className={`rail-foot-text setup-notes setup-note ${first.k}`} role="status" aria-label="Setup notes" {...tipAttrs({ title: rows.length > 1 ? `${rows.length} setup notes` : 'Setup note', body: rows.map((r) => r.t).join(' ') })}>
      <span className="rail-foot-line">{first.t}</span>
      {slot && isDryingNote(first.t) ? (
        <LinkButton {...tipAttrs({ title: "It's dry", body: `Hides this for the spool in ${slot.label} until it is swapped, or for 7 days.` })} onClick={() => markDry(printerId, slot)}>
          It's dry
        </LinkButton>
      ) : null}
      {after}
    </p>
  )
}

/** The notes as a short list under the Filament block, while there is no rail to hold them (no slots yet). */
export function SetupNotes() {
  const notes = useSetupNotes()
  if (!notes) return null
  const { rows, slot, printerId } = notes
  return (
    <div className="setup-notes" role="status" aria-label="Setup notes">
      {rows.map(({ t, k }) => (
        <p key={t} className={`sx-small setup-note ${k}`}>
          {t}
          {slot && isDryingNote(t) ? (
            <>
              {' '}
              <Button size="sm" variant="ghost" icon="check" tip={{ title: "It's dry", body: `Hides this for the spool in ${slot.label} until it is swapped, or for 7 days.` }} onClick={() => markDry(printerId, slot)}>
                It's dry
              </Button>
            </>
          ) : null}
        </p>
      ))}
    </div>
  )
}
