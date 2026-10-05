// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// schedule: plan plates across printers to meet due dates at the lowest machine
// cost. It plans only. Queueing stays with printer.queue and its approval card.
import type { Cell, Tone } from '@slicerx/contracts'
import { z } from 'zod'
import { fmtDuration, fmtMoney, type ToolShared } from '../../src/shared'
import { defineSkill, type ToolContext } from '../../src/tool'
import { fitGrid } from '../arrange/index'
import { buildVolume, pickObject } from '../common'
import { fmtWhen, loadPrinters, materialKey, nowMs, parseDue, perCopy, filamentDoc, printerCaps, readSpools, slotGrams, type PerCopy } from '../fleet_common/index'
import { fitsVolume } from '../printer_match/index'

export interface PlanPrinter {
  id: string
  name: string
  /** Seconds from now until the printer can start, 0 when idle. */
  readyS: number
  /** Machine cost per hour. */
  rate: number
  loaded(materialKey: string): boolean
}

export interface PlanPlate {
  id: string
  job: string
  jobIndex: number
  materialKey: string
  copies: number
  durationS: number
  /** Seconds from now. */
  dueS?: number
  eligible(printerId: string): { ok: boolean; needs: string[]; reason?: string }
}

export interface Assignment {
  plateId: string
  job: string
  jobIndex: number
  copies: number
  printerId: string
  printerName: string
  startS: number
  endS: number
  swap: boolean
  needs: string[]
  cost: number
  dueS?: number
  onTime: boolean | null
}

const cmp = (a: number[], b: number[]): number => {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Greedy plan. Plates with due dates go first, earliest due first, longest first
 * within a tie. A plate takes, among printers that can meet its due date: fewest
 * needed changes, material already loaded, idle now, lowest machine cost. With
 * no due date it takes the earliest finish. When no printer can meet the date it
 * takes the earliest finish.
 */
export function planSchedule(printers: PlanPrinter[], plates: PlanPlate[], swapS: number): { assignments: Assignment[]; unassigned: { plate: PlanPlate; reason: string }[] } {
  const busy = new Map(printers.map((p) => [p.id, p.readyS]))
  const order = plates.map((p, i) => ({ p, i })).sort((a, b) => (a.p.dueS ?? Infinity) - (b.p.dueS ?? Infinity) || b.p.durationS - a.p.durationS || a.i - b.i)
  const assignments: Assignment[] = []
  const unassigned: { plate: PlanPlate; reason: string }[] = []
  for (const { p: plate } of order) {
    const cands: { pr: PlanPrinter; start: number; end: number; swap: boolean; needs: string[]; cost: number; meets: boolean; idle: boolean }[] = []
    const why: string[] = []
    for (const pr of printers) {
      const el = plate.eligible(pr.id)
      if (!el.ok) {
        why.push(`${pr.name}: ${el.reason ?? 'not eligible'}`)
        continue
      }
      const start = busy.get(pr.id) ?? 0
      const swap = !pr.loaded(plate.materialKey)
      const end = start + plate.durationS + (swap ? swapS : 0)
      cands.push({ pr, start, end, swap, needs: el.needs, cost: (pr.rate * plate.durationS) / 3600, meets: plate.dueS === undefined || end <= plate.dueS, idle: start === 0 })
    }
    if (cands.length === 0) {
      unassigned.push({ plate, reason: why.join('; ') || 'no printer available' })
      continue
    }
    const anyMeets = plate.dueS !== undefined && cands.some((c) => c.meets)
    cands.sort((a, b) =>
      anyMeets
        ? cmp([a.needs.length, Number(a.swap), Number(!a.idle), a.cost, a.end], [b.needs.length, Number(b.swap), Number(!b.idle), b.cost, b.end]) || a.pr.id.localeCompare(b.pr.id)
        : cmp([a.needs.length, a.end, a.cost], [b.needs.length, b.end, b.cost]) || a.pr.id.localeCompare(b.pr.id),
    )
    const c = cands.filter((x) => (anyMeets ? x.meets : true))[0]
    if (!c) continue
    busy.set(c.pr.id, c.end)
    const a: Assignment = { plateId: plate.id, job: plate.job, jobIndex: plate.jobIndex, copies: plate.copies, printerId: c.pr.id, printerName: c.pr.name, startS: c.start, endS: c.end, swap: c.swap, needs: c.needs, cost: c.cost, onTime: plate.dueS === undefined ? null : c.end <= plate.dueS }
    if (plate.dueS !== undefined) a.dueS = plate.dueS
    assignments.push(a)
  }
  assignments.sort((a, b) => a.jobIndex - b.jobIndex || a.startS - b.startS)
  return { assignments, unassigned }
}

const jobSchema = z.object({
  objectId: z.string().min(1).describe('Object id or name from the project'),
  copies: z.number().int().min(1).max(1000).describe('How many to make'),
  material: z.string().min(1).describe('Filament, such as "PLA" or "ASA"'),
  dueDate: z.string().optional().describe('ISO date or date-time the job must be done by'),
  minutesPerCopy: z.number().min(0.1).max(6000).optional().describe('Print minutes for one copy, when known. Otherwise one copy is sliced'),
  gramsPerCopy: z.number().min(0).max(5000).optional().describe('Filament grams for one copy, when known'),
  copiesPerPlate: z.number().int().min(1).max(500).optional().describe('Copies that fit on one plate. Otherwise worked out from the smallest bed in use'),
})
export type ScheduleJobIn = z.infer<typeof jobSchema>

export interface ScheduleOptions {
  jobs: ScheduleJobIn[]
  printers?: string[] | undefined
  fleet?: string | undefined
  changeoverMinutes?: number | undefined
  defaultRatePerHour?: number | undefined
}

export interface JobResult {
  index: number
  objectId: string
  material: string
  copies: number
  plates: number
  perCopyS: number | null
  gramsPerCopy: number | null
  finishS: number | null
  dueS: number | null
  onTime: boolean | null
  printers: string[]
  source: string
  error?: string
}

export interface Built {
  now: number
  assignments: Assignment[]
  jobs: JobResult[]
  skipped: { name: string; reason: string }[]
  unassigned: { job: string; reason: string }[]
  notes: string[]
  citations: Set<string>
}

/** Works out per copy time, plates and eligibility for each job, then plans. */
export async function buildSchedule(ctx: ToolContext, shared: ToolShared, o: ScheduleOptions): Promise<Built> {
  const now = nowMs(ctx)
  const { views, notes } = await loadPrinters(ctx, { printers: o.printers, fleet: o.fleet })
  const sp = await readSpools(ctx)
  if (sp.note) notes.push(sp.note)
  const skipped: Built['skipped'] = []
  const usable = views.filter((v) => {
    const s = v.status?.state ?? 'offline'
    if (s === 'idle' || s === 'finished' || s === 'printing' || s === 'preparing') return true
    skipped.push({ name: v.info.name, reason: s === 'paused' ? 'paused, needs a person' : s })
    return false
  })
  const guessed = usable.filter((v) => (v.status?.state === 'printing' || v.status?.state === 'preparing') && v.status.timeLeftS === undefined)
  if (guessed.length) notes.push(`${guessed.map((v) => v.info.name).join(', ')} did not report time left, assumed 1 h`)
  const finished = usable.filter((v) => v.status?.state === 'finished')
  if (finished.length) notes.push(`${finished.map((v) => v.info.name).join(', ')} finished a job: clear the bed before the next plate`)
  const printers: PlanPrinter[] = usable.map((v) => {
    const st = v.status
    const keys = new Set((st?.slots ?? []).flatMap((s) => (s.material ? [materialKey(ctx.kb, s.material)] : [])))
    const busy = st?.state === 'printing' || st?.state === 'preparing'
    return {
      id: v.info.id,
      name: v.info.name,
      readyS: busy ? (st?.timeLeftS ?? 3600) : 0,
      rate: shared.machineRates.get(v.info.id) ?? o.defaultRatePerHour ?? 0,
      loaded: (k) => keys.has(k),
    }
  })

  const cache = new Map<string, PerCopy | string>()
  const plates: PlanPlate[] = []
  const jobs: JobResult[] = []
  const citations = new Set<string>()
  for (const [index, job] of o.jobs.entries()) {
    const label = `${job.objectId} x${job.copies}`
    const res: JobResult = { index, objectId: job.objectId, material: job.material, copies: job.copies, plates: 0, perCopyS: null, gramsPerCopy: null, finishS: null, dueS: null, onTime: null, printers: [], source: '' }
    jobs.push(res)
    const mat = filamentDoc(ctx.kb, job.material)
    const mkey = materialKey(ctx.kb, job.material)
    if (mat) for (const s of mat.sources.slice(0, 2)) citations.add(s)
    const pc = await perCopy(ctx, shared, job.objectId, job.material, cache)
    let timeS: number
    if (job.minutesPerCopy !== undefined) {
      timeS = job.minutesPerCopy * 60
      res.source = 'input'
      res.gramsPerCopy = job.gramsPerCopy ?? (typeof pc === 'string' ? null : pc.grams)
    } else if (typeof pc === 'string') {
      res.error = pc
      continue
    } else {
      timeS = pc.timeS
      res.source = pc.source + (pc.note ? ` (${pc.note})` : '')
      res.gramsPerCopy = job.gramsPerCopy ?? pc.grams
    }
    res.perCopyS = timeS
    let dueS: number | undefined
    if (job.dueDate) {
      const d = parseDue(job.dueDate)
      if (Number.isFinite(d)) {
        dueS = (d - now) / 1000
        res.dueS = dueS
      } else notes.push(`"${job.dueDate}" is not a date, ignored for ${label}`)
    }
    const obj = pickObject(ctx, job.objectId)
    const bbox = obj?.bboxMm
    const volOf = (v: (typeof usable)[number]) => (v.doc ? buildVolume(ctx.kb, v.doc.id) : null)
    const fits = (v: (typeof usable)[number]): boolean => {
      const vol = volOf(v)
      return !bbox || !vol || fitsVolume(bbox, vol)
    }
    let cpp = job.copiesPerPlate
    if (cpp === undefined) {
      const caps = usable.filter((v) => fits(v) && volOf(v)).map((v) => (bbox ? fitGrid(volOf(v) ?? { x: 0, y: 0, z: 0 }, bbox[0], bbox[1], 6).perPlate : 0))
      const min = caps.length ? Math.min(...caps) : 0
      if (min > 0) cpp = min
      else {
        cpp = job.copies
        notes.push(`No bed size known for ${label}, so all copies are planned as one plate. Give copiesPerPlate to change that`)
      }
    }
    cpp = Math.max(1, Math.min(cpp, job.copies))
    let left = job.copies
    let n = 0
    while (left > 0) {
      const c = Math.min(cpp, left)
      left -= c
      n++
      plates.push({
        id: `${index + 1}.${n}`,
        job: label,
        jobIndex: index,
        materialKey: mkey,
        copies: c,
        durationS: timeS * c,
        ...(dueS !== undefined ? { dueS } : {}),
        eligible(printerId) {
          const v = usable.find((x) => x.info.id === printerId)
          if (!v) return { ok: false, needs: [], reason: 'not in scope' }
          const vol = volOf(v)
          if (bbox && vol && !fitsVolume(bbox, vol)) return { ok: false, needs: [], reason: `too big for ${vol.x} x ${vol.y} x ${vol.z} mm` }
          const caps = printerCaps(v.doc, mat)
          if (caps.blockers.length) return { ok: false, needs: [], reason: caps.blockers.join(', ') }
          if (v.doc) for (const s of v.doc.sources.slice(0, 1)) citations.add(s)
          return { ok: true, needs: caps.needs }
        },
      })
    }
    res.plates = n
  }
  const swapS = (o.changeoverMinutes ?? 10) * 60
  const plan = planSchedule(printers, plates, swapS)
  for (const j of jobs) {
    const mine = plan.assignments.filter((a) => a.jobIndex === j.index)
    if (mine.length === 0) continue
    j.finishS = Math.max(...mine.map((a) => a.endS))
    j.printers = [...new Set(mine.map((a) => a.printerName))]
    j.onTime = j.dueS === null ? null : mine.length === j.plates && j.finishS <= j.dueS
  }
  const unassigned = plan.unassigned.map((u) => ({ job: u.plate.job, reason: u.reason }))
  for (const j of jobs) if (j.plates > 0 && !plan.assignments.some((a) => a.jobIndex === j.index)) j.onTime = j.dueS === null ? null : false

  // Spools that may run out under the plan.
  const byKey = new Map<string, { printerName: string; view: (typeof usable)[number]; material: string; grams: number }>()
  for (const a of plan.assignments) {
    const j = jobs[a.jobIndex]
    const v = usable.find((x) => x.info.id === a.printerId)
    if (!j || !v || a.swap || !j.gramsPerCopy) continue
    const k = `${a.printerId}|${materialKey(ctx.kb, j.material)}`
    const cur = byKey.get(k) ?? { printerName: a.printerName, view: v, material: j.material, grams: 0 }
    cur.grams += j.gramsPerCopy * a.copies
    byKey.set(k, cur)
  }
  for (const b of byKey.values()) {
    const mk = materialKey(ctx.kb, b.material)
    const slot = (b.view.status?.slots ?? []).find((s) => s.material && materialKey(ctx.kb, s.material) === mk)
    const g = slot ? slotGrams(slot, sp.spools) : null
    if (g && g.grams < b.grams) notes.push(`${b.printerName}: ${b.material} needs about ${Math.round(b.grams)} g but the loaded spool has about ${Math.round(g.grams)} g${g.source === 'estimated' ? ' (estimated from percent)' : ''}. Run spool_fit`)
  }
  return { now, assignments: plan.assignments, jobs, skipped, unassigned, notes, citations }
}

const tone = (b: boolean | null): Tone => (b === null ? 'dim' : b ? 'ok' : 'bad')

export function createSchedule(shared: ToolShared) {
  return defineSkill({
    name: 'schedule',
    version: '1.0.0',
    permission: 'read',
    description:
      'Plan jobs across printers: for each job (object, copies, material, optional due date) it estimates time per copy by slicing one copy, splits copies into plates, and assigns each plate to a printer that has the material loaded (else notes a spool swap), idle printers first, lowest machine cost, meeting due dates. Returns a schedule table with start and finish times and whether each job is on time. Skips paused, error and offline printers. All printers by default, or named printers, or a fleet group. It only plans and queues nothing: after the user accepts the plan, arrange and slice the plates, then call printer.queue once per plate, which asks for approval.',
    input: z.object({
      jobs: z.array(jobSchema).min(1).max(20).describe('Jobs to plan'),
      printers: z.array(z.string()).optional().describe('Printer ids to use'),
      fleet: z.string().optional().describe('A fleet group name, when the user named one. Omit for all printers'),
      changeoverMinutes: z.number().min(0).max(120).optional().describe('Minutes a spool swap takes (default 10)'),
      defaultRatePerHour: z.number().min(0).max(100).optional().describe('Machine cost per hour for printers with none set'),
    }),
    args: (i) => `${i.jobs.map((j) => `${j.objectId}x${j.copies}`).join(',')}${i.fleet ? ` --fleet "${i.fleet}"` : ''}`,
    async run(i, ctx) {
      ctx.progress('planning')
      const b = await buildSchedule(ctx, shared, i)
      const failed = b.jobs.filter((j) => j.error)
      if (b.assignments.length === 0) {
        return { ok: false, summary: failed[0]?.error ?? b.unassigned[0]?.reason ?? 'No printer can take these jobs right now', output: { jobs: b.jobs, skippedPrinters: b.skipped, unassigned: b.unassigned, notes: b.notes }, untrusted: true }
      }
      const when = (s: number): string => fmtWhen(b.now + s * 1000)
      const rows: Cell[][] = b.assignments.map((a) => [
        a.plateId,
        a.job,
        a.printerName,
        String(a.copies),
        when(a.startS),
        when(a.endS),
        a.dueS === undefined ? '' : when(a.dueS).slice(0, 10),
        a.onTime === null ? { text: 'no date', tone: 'dim' } : a.onTime ? { text: 'on time', tone: 'ok' } : { text: 'late', tone: 'bad' },
        [a.swap ? 'swap spool first' : 'loaded', ...a.needs.map((n) => `needs ${n}`)].join('; '),
      ])
      const jobRows: Cell[][] = b.jobs.map((j) => [
        `${j.objectId} x${j.copies} ${j.material}`,
        j.error ? { text: j.error, tone: 'bad' } : `${j.plates} plate${j.plates === 1 ? '' : 's'} on ${j.printers.join(', ') || 'no printer'}`,
        j.perCopyS === null ? '' : `${fmtDuration(j.perCopyS)} per copy`,
        j.finishS === null ? '' : when(j.finishS),
        { text: j.onTime === null ? 'no date' : j.onTime ? 'on time' : 'late', tone: tone(j.onTime) },
      ])
      const late = b.jobs.filter((j) => j.onTime === false).length
      const dated = b.jobs.filter((j) => j.onTime !== null).length
      const cost = b.assignments.reduce((s, a) => s + a.cost, 0)
      const printersUsed = new Set(b.assignments.map((a) => a.printerId)).size
      const nextSteps = 'Nothing is queued. After the user agrees, arrange and slice the plates, then call printer.queue for each plate (each asks for approval).'
      return {
        summary: `${b.assignments.length} plates on ${printersUsed} printer${printersUsed === 1 ? '' : 's'}, ${dated === 0 ? 'no due dates' : late === 0 ? 'all jobs on time' : `${late} of ${dated} jobs late`}, ${fmtMoney(cost)} machine cost. Not queued`,
        output: {
          queued: false,
          next: nextSteps,
          schedule: b.assignments.map((a) => ({ plate: a.plateId, job: a.job, printerId: a.printerId, copies: a.copies, start: new Date(b.now + a.startS * 1000).toISOString(), finish: new Date(b.now + a.endS * 1000).toISOString(), spoolSwap: a.swap, needs: a.needs, onTime: a.onTime, machineCost: Math.round(a.cost * 100) / 100 })),
          jobs: b.jobs.map((j) => ({ ...j, finish: j.finishS === null ? null : new Date(b.now + j.finishS * 1000).toISOString() })),
          skippedPrinters: b.skipped,
          unassigned: b.unassigned,
          notes: b.notes,
        },
        display: [
          { kind: 'table', head: ['job', 'plan', 'time', 'done', 'due date'], rows: jobRows },
          { kind: 'table', head: ['plate', 'job', 'printer', 'copies', 'start', 'finish', 'due', 'status', 'notes'], rows },
          {
            kind: 'log',
            lines: [
              ...b.skipped.map((s) => ({ text: `${s.name} skipped: ${s.reason}`, tone: 'warn' as Tone })),
              ...b.unassigned.map((u) => ({ text: `${u.job} could not be placed: ${u.reason}`, tone: 'bad' as Tone })),
              ...b.notes.map((t) => ({ text: t, tone: 'dim' as Tone })),
              { text: nextSteps, tone: 'hl' as Tone },
            ],
          },
        ],
        untrusted: true,
        citations: ctx.kb.cite(b.citations),
      }
    },
  })
}
