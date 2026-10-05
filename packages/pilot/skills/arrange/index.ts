// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Packs copies onto plates by bed size, one plate per chosen printer.
import { z } from 'zod'
import type { ProjectPlate } from '../../src/project'
import type { ToolShared } from '../../src/shared'
import { defineSkill } from '../../src/tool'
import { buildVolume, printerVolume, pickObject, round, type BuildVolume } from '../common'

export function fitGrid(bed: BuildVolume, x: number, y: number, spacing: number): { perPlate: number; rotated: boolean } {
  const fit = (a: number, b: number): number => Math.max(0, Math.floor((bed.x + spacing) / (a + spacing))) * Math.max(0, Math.floor((bed.y + spacing) / (b + spacing)))
  const a = fit(x, y)
  const b = fit(y, x)
  return b > a ? { perPlate: b, rotated: true } : { perPlate: a, rotated: false }
}

export function createArrange(shared: ToolShared) {
  return defineSkill({
    name: 'arrange',
    version: '1.6.2',
    permission: 'slice',
    description:
      'Pack copies of an object onto plates. Give printer ids to put one plate on each, or a printer model for a fit check. With checkFit it only reports whether the object fits the build volume. Changes only the project.',
    input: z.object({
      objectId: z.string().optional().describe('Object id or name; defaults to the first object'),
      count: z.number().int().min(1).max(500).optional().describe('Total copies'),
      printers: z.array(z.string()).optional().describe('Printer ids, one plate each'),
      printerModel: z.string().optional().describe('Printer model when it is not one of your printers, such as "A1 mini"'),
      plates: z.number().int().min(1).max(50).optional(),
      spacing: z.number().min(0).max(50).optional().describe('Gap between copies, mm (default 6)'),
      checkFit: z.boolean().optional(),
    }),
    args: (i) =>
      [i.checkFit ? `--check-fit ${i.objectId ?? ''}`.trim() : null, i.printerModel ? `--printer "${i.printerModel}"` : null, i.plates ? `--plates ${i.plates}` : null, i.count ? `--count ${i.count}` : null, i.printers?.length ? `--printers ${i.printers.join(',')}` : null, i.spacing !== undefined ? `--spacing ${i.spacing}` : null]
        .filter(Boolean)
        .join(' '),
    async run(i, ctx) {
      const obj = pickObject(ctx, i.objectId)
      if (!obj) return { ok: false, summary: 'No object in the project' }
      const [ox, oy, oz] = obj.bboxMm
      const spacing = i.spacing ?? 6

      if (i.checkFit) {
        const model = i.printerModel ?? ctx.context.machine?.printer ?? ''
        const vol = buildVolume(ctx.kb, model)
        if (!vol) return { ok: false, summary: `Unknown build volume for "${model}"` }
        const over = [ox - vol.x, oy - vol.y, oz - vol.z]
        const axes = ['X', 'Y', 'Z'].filter((_, k) => (over[k] ?? 0) > 0)
        const fits = axes.length === 0
        const worst = Math.max(...over)
        return {
          summary: fits ? `Fits the ${model}` : `Over the ${model} by ${round(worst, 0)} mm in ${axes.join(' and ')}`,
          output: { fits, object: { x: ox, y: oy, z: oz }, buildVolume: vol, overBy: { x: round(over[0] ?? 0), y: round(over[1] ?? 0), z: round(over[2] ?? 0) } },
          display: [{ kind: 'kv', rows: [['model', `${round(ox, 0)} x ${round(oy, 0)} x ${round(oz, 0)} mm`], ['build volume', `${vol.x} x ${vol.y} x ${vol.z} mm`], ['result', fits ? { text: 'fits', tone: 'ok' } : { text: `over by ${round(worst, 0)} mm in ${axes.join(' and ')}`, tone: 'warn' }]] }],
        }
      }

      const count = i.count ?? 1
      const targets: { printerId?: string; label: string; vol: BuildVolume }[] = []
      for (const pid of i.printers ?? []) {
        const fv = await printerVolume(ctx, pid)
        if (!fv) return { ok: false, summary: `Unknown printer ${pid}` }
        if (!fv.volume) return { ok: false, summary: `No build volume known for ${fv.model}` }
        targets.push({ printerId: pid, label: `${fv.name}  ${fv.model}`, vol: fv.volume })
      }
      if (targets.length === 0) {
        const model = i.printerModel ?? ctx.context.machine?.printer ?? ''
        const vol = buildVolume(ctx.kb, model)
        if (!vol) return { ok: false, summary: `Unknown build volume for "${model}"` }
        const n = i.plates ?? 1
        for (let k = 0; k < n; k++) targets.push({ label: model, vol })
      }
      if (targets.some((t) => oz > t.vol.z)) return { ok: false, summary: `Too tall: ${round(oz, 0)} mm is over the build height. Use cut first.` }

      const plates: ProjectPlate[] = []
      let left = count
      const caps = targets.map((t) => fitGrid(t.vol, ox, oy, spacing))
      const even = Math.ceil(count / targets.length)
      for (let k = 0; k < targets.length && left > 0; k++) {
        const t = targets[k]
        const cap = caps[k]
        if (!t || !cap) continue
        const n = Math.min(cap.perPlate, even, left)
        if (n <= 0) continue
        left -= n
        const plate: ProjectPlate = { index: plates.length + 1, items: [{ objectId: obj.id, copies: n, ...(cap.rotated ? { rotation: 'z90' } : {}) }] }
        if (t.printerId) plate.printerId = t.printerId
        plates.push(plate)
      }
      if (left > 0) return { ok: false, summary: `Only ${count - left} of ${count} fit on ${targets.length} plates. Add plates or printers.`, output: { placed: count - left, count } }
      ctx.project?.setPlates(plates)
      // Old slices describe plates that no longer exist.
      shared.slices.clear()
      const rows = plates.map((p, k) => {
        const t = targets[k]
        const copies = p.items[0]?.copies ?? 0
        const use = t ? Math.round(((copies * ox * oy) / (t.vol.x * t.vol.y)) * 100) : 0
        return [String(p.index), t?.label ?? '', String(copies), `${use}%`]
      })
      const per = plates.map((p) => p.items[0]?.copies ?? 0)
      return {
        summary: per.every((n) => n === per[0]) ? `${per[0]} per plate on ${plates.length} plate${plates.length === 1 ? '' : 's'}` : `${count} copies on ${plates.length} plates (${per.join(', ')})`,
        output: { plates: plates.map((p, k) => ({ plate: p.index, printerId: p.printerId, copies: p.items[0]?.copies, bedUse: rows[k]?.[3] })) },
        display: [{ kind: 'table', head: ['plate', 'printer', 'copies', 'bed use'], rows }],
      }
    },
  })
}
