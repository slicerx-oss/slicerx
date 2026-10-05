// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// fleet_overview: what every printer is doing, and the short list of things
// that need a person.
import type { Cell, PrinterStatus, Tone } from '@slicerx/contracts'
import { z } from 'zod'
import { fmtDuration } from '../../src/shared'
import { defineSkill } from '../../src/tool'
import { loadPrinters, readSpools, slotGrams, type SpoolRec } from '../fleet_common/index'

export interface Attention {
  printerId: string
  name: string
  kind: 'paused' | 'error' | 'finished' | 'low_filament' | 'offline'
  text: string
}

export const LOW_FILAMENT_PCT = 15

const TONE: Record<string, Tone> = { idle: 'ok', finished: 'warn', printing: 'run', preparing: 'run', paused: 'warn', error: 'bad', offline: 'bad' }

/** The things that need a person, from one printer's status. */
export function needsPerson(printerId: string, name: string, status: PrinterStatus | null, lowPct = LOW_FILAMENT_PCT): Attention[] {
  const out: Attention[] = []
  const add = (kind: Attention['kind'], text: string): void => void out.push({ printerId, name, kind, text })
  if (!status || status.state === 'offline') add('offline', 'offline')
  else if (status.state === 'paused') add('paused', `paused${status.jobName ? ` on ${status.jobName}` : ''}`)
  else if (status.state === 'error') add('error', 'in an error state')
  else if (status.state === 'finished') add('finished', `finished${status.jobName ? ` ${status.jobName}` : ''}, part still on the bed`)
  for (const s of status?.slots ?? []) {
    if (s.material && s.remainingPct !== undefined && s.remainingPct < lowPct) add('low_filament', `slot ${s.id} ${s.material} at ${s.remainingPct}%`)
  }
  return out
}

function slotText(s: PrinterStatus['slots'][number], spools: SpoolRec[]): string {
  if (!s.material) return `${s.id} empty`
  const g = slotGrams(s, spools)
  const left = s.remainingPct !== undefined ? ` ${s.remainingPct}%` : ''
  return `${s.id} ${s.material}${s.color ? ` ${s.color}` : ''}${left}${g?.source === 'spoolman' ? ` (${Math.round(g.grams)} g)` : ''}`
}

export function createFleetOverview() {
  return defineSkill({
    name: 'fleet_overview',
    version: '1.0.0',
    permission: 'read',
    description:
      'Status of every printer in one call: state, current job with progress and time left, loaded filament per slot with what is left, and printer messages. Ends with a list of what needs a person: paused, error, finished with a part still on the bed, filament under 15 percent, or offline. Use it for "what is every printer doing" or before planning work. All printers by default, or named printers, or a fleet group. Read only.',
    input: z.object({
      printers: z.array(z.string()).optional().describe('Printer ids to include, such as ["bay-1","bay-2"]'),
      fleet: z.string().optional().describe('A fleet group name, when the user named one. Omit for all printers'),
      lowFilamentPct: z.number().min(1).max(50).optional().describe('Flag slots below this percent (default 15)'),
    }),
    args: (i) => [i.fleet ? `--fleet "${i.fleet}"` : null, i.printers?.length ? `--printers ${i.printers.join(',')}` : null].filter(Boolean).join(' ') || '--all',
    async run(i, ctx) {
      const { views, notes } = await loadPrinters(ctx, { printers: i.printers, fleet: i.fleet })
      if (views.length === 0) return { ok: false, summary: 'No printers to report on', ...(notes.length ? { output: { notes } } : {}) }
      const sp = await readSpools(ctx)
      const attention = views.flatMap((v) => needsPerson(v.info.id, v.info.name, v.status, i.lowFilamentPct ?? LOW_FILAMENT_PCT))
      const rows: Cell[][] = views.map((v) => {
        const s = v.status
        const state = s?.state ?? 'offline'
        const job = s?.jobName ? `${s.jobName}${s.progress !== undefined ? `, ${Math.round(s.progress * 100)}%` : ''}` : ''
        return [
          v.info.name,
          v.info.model,
          { text: state, tone: TONE[state] ?? 'dim' },
          job,
          s?.timeLeftS ? fmtDuration(s.timeLeftS) : '',
          (s?.slots ?? []).map((x) => slotText(x, sp.spools)).join('; '),
          s?.message ?? '',
        ]
      })
      const counts = new Map<string, number>()
      for (const v of views) counts.set(v.status?.state ?? 'offline', (counts.get(v.status?.state ?? 'offline') ?? 0) + 1)
      const tally = [...counts].map(([k, n]) => `${n} ${k}`).join(', ')
      const needTone = (k: Attention['kind']): Tone => (k === 'error' || k === 'offline' ? 'bad' : 'warn')
      return {
        summary: `${views.length} printers: ${tally}. ${attention.length ? `${attention.length} need${attention.length === 1 ? 's' : ''} a person` : 'Nothing needs a person'}`,
        output: {
          printers: views.map((v) => ({
            id: v.info.id,
            name: v.info.name,
            model: v.info.model,
            state: v.status?.state ?? 'offline',
            job: v.status?.jobName ?? null,
            progress: v.status?.progress ?? null,
            timeLeftS: v.status?.timeLeftS ?? null,
            filament: (v.status?.slots ?? []).map((s) => ({ slot: s.id, material: s.material ?? null, color: s.color ?? null, remainingPct: s.remainingPct ?? null, grams: slotGrams(s, sp.spools)?.grams ?? null })),
            message: v.status?.message ?? null,
            cameraAvailable: v.status?.cameraAvailable ?? false,
          })),
          needsAPerson: attention,
          notes: [...notes, ...(sp.note ? [sp.note] : [])],
        },
        display: [
          { kind: 'table', head: ['printer', 'model', 'state', 'job', 'time left', 'filament', 'message'], rows },
          {
            kind: 'log',
            lines: attention.length
              ? attention.map((a) => ({ text: `${a.name}: ${a.text}`, tone: needTone(a.kind) }))
              : [{ text: 'No printer needs a person right now', tone: 'ok' as Tone }],
          },
        ],
        untrusted: true,
      }
    },
  })
}
