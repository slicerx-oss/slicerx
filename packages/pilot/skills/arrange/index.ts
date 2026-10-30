// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Packs copies onto plates by bed size, one plate per chosen printer.
import { z } from 'zod'
import { leftOffWords, movedWords, type PilotProject, type PlateCheckSummary, type ProjectPlate } from '../../src/project'
import type { ToolShared } from '../../src/shared'
import { defineSkill } from '../../src/tool'
import { buildVolume, printerVolume, pickObject, round, type BuildVolume } from '../common'

export function fitGrid(bed: BuildVolume, x: number, y: number, spacing: number): { perPlate: number; rotated: boolean } {
  const fit = (a: number, b: number): number =>
    bed.round ? circleCells(Math.min(bed.x, bed.y), a, b, spacing).length : Math.max(0, Math.floor((bed.x + spacing) / (a + spacing))) * Math.max(0, Math.floor((bed.y + spacing) / (b + spacing)))
  const a = fit(x, y)
  const b = fit(y, x)
  return b > a ? { perPlate: b, rotated: true } : { perPlate: a, rotated: false }
}

/**
 * Centers of the a by b cells, `spacing` mm apart, that fit whole inside a round bed of `diameter` mm, relative to its
 * center. The grid is tried with a cell on the center and with a gap there, on each axis, and the fullest one wins.
 */
export function circleCells(diameter: number, a: number, b: number, spacing: number): [number, number][] {
  const r = diameter / 2
  const px = a + spacing
  const py = b + spacing
  if (!(a > 0 && b > 0) || Math.hypot(a, b) > diameter) return []
  const nx = Math.ceil(diameter / px) + 1
  const ny = Math.ceil(diameter / py) + 1
  let best: [number, number][] = []
  for (const ox of [0, px / 2]) {
    for (const oy of [0, py / 2]) {
      const cells: [number, number][] = []
      for (let i = -nx; i <= nx; i++) {
        for (let j = -ny; j <= ny; j++) {
          const cx = ox + i * px
          const cy = oy + j * py
          // The cell's farthest corner from the center decides it.
          if (Math.hypot(Math.abs(cx) + a / 2, Math.abs(cy) + b / 2) <= r + 1e-9) cells.push([cx, cy])
        }
      }
      if (cells.length > best.length) best = cells
    }
  }
  return best
}

/**
 * heimdall's plate check of each plate the arrange laid out, where the project has one (by object, an engine that
 * checks): the arrange stops there, and says which pairs a slice would still be refused for, with the fixes.
 */
async function checkAfter(project: PilotProject | undefined, plates: readonly number[]): Promise<{ check: ({ plate: number } & PlateCheckSummary)[]; leftSure: { plate: number; a: { id: string; name: string }; b: { id: string; name: string } }[]; said: string }> {
  const check: ({ plate: number } & PlateCheckSummary)[] = []
  if (project?.plateCheck) {
    for (const plate of [...new Set(plates)]) {
      // A check that fails leaves the layout as it is; the slice still decides.
      const c = await project.plateCheck(plate).catch(() => null)
      if (c) check.push({ plate, ...c })
    }
  }
  const leftSure = check.flatMap((c) => c.leftSure.map((p) => ({ plate: c.plate, a: p.a, b: p.b })))
  const said = leftSure.length ? `Printed by object, ${leftSure.map((p) => `${p.a.name} and ${p.b.name} on plate ${p.plate}`).join(', ')} would still be refused: see leftSure and the plate's fixes in check.` : ''
  return { check, leftSure, said }
}

/** The bed area copies can use, mm2: the circle on a round bed. */
function bedArea(v: BuildVolume): number {
  return v.round ? (Math.PI * Math.min(v.x, v.y) ** 2) / 4 : v.x * v.y
}

export function createArrange(shared: ToolShared) {
  return defineSkill({
    name: 'arrange',
    version: '1.10.0',
    permission: 'slice',
    description:
      "Pack copies of an object onto plates, around the other objects, which keep their places. It keeps room for brims and skirts, clear of excluded areas and the prime tower. Each copy may turn about Z where that fits more, as Arrange in the app turns them, and turns gives the turn of each copy by plate object id and plate. Copies with no room around the others go to new plates, and moved lists them by object id and plate; no object is taken off its plate. Give printer ids to put one plate on each, or a printer model for a fit check. With checkFit it only reports whether the object fits the build volume. On a plate printed by object (sx engine), the new layout gets heimdall's plate check: check lists each plate's result (clean, collisions with certainty, leftSure, fixes, unchecked), and leftSure the pairs a slice would still be refused for; arrange stops there and does not try another layout. Changes only the project.",
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
        // On a round bed the footprint's diagonal has to fit the diameter.
        const across = vol.round ? Math.hypot(ox, oy) - Math.min(vol.x, vol.y) : 0
        const over = vol.round ? [across, across, oz - vol.z] : [ox - vol.x, oy - vol.y, oz - vol.z]
        const axes = ['X', 'Y', 'Z'].filter((_, k) => (over[k] ?? 0) > 0)
        const fits = axes.length === 0
        const worst = Math.max(...over)
        return {
          summary: fits ? `Fits the ${model}` : `Over the ${model} by ${round(worst, 0)} mm in ${axes.join(' and ')}`,
          output: { fits, object: { x: ox, y: oy, z: oz }, buildVolume: vol, overBy: { x: round(over[0] ?? 0), y: round(over[1] ?? 0), z: round(over[2] ?? 0) } },
          display: [{ kind: 'kv', rows: [['model', `${round(ox, 0)} x ${round(oy, 0)} x ${round(oz, 0)} mm`], ['build volume', vol.round ? `${Math.min(vol.x, vol.y)} mm round, ${vol.z} mm tall` : `${vol.x} x ${vol.y} x ${vol.z} mm`], ['result', fits ? { text: 'fits', tone: 'ok' } : { text: `over by ${round(worst, 0)} mm in ${axes.join(' and ')}`, tone: 'warn' }]] }],
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
      // How many fit each plate: the host's own arrange, which turns each copy where that fits more, else a grid count from the box.
      const caps = await Promise.all(targets.map(async (t, k) => (ctx.project?.arrangeCapacity ? await ctx.project.arrangeCapacity(obj.id, t.vol, spacing, k + 1) : fitGrid(t.vol, ox, oy, spacing).perPlate)))
      const even = Math.ceil(count / targets.length)
      for (let k = 0; k < targets.length && left > 0; k++) {
        const t = targets[k]
        const cap = caps[k]
        if (!t || cap === undefined) continue
        const n = Math.min(cap, even, left)
        if (n <= 0) continue
        left -= n
        const plate: ProjectPlate = { index: plates.length + 1, items: [{ objectId: obj.id, copies: n }] }
        if (t.printerId) plate.printerId = t.printerId
        plates.push(plate)
      }
      if (left > 0) return { ok: false, summary: `Only ${count - left} of ${count} fit on ${targets.length} plates. Add plates or printers.`, output: { placed: count - left, count } }
      if (ctx.project?.arrangeObject) {
        // The other objects stay where they are; copies with no room around them go to new plates.
        const r = await ctx.project.arrangeObject(obj.id, plates.map((p) => ({ index: p.index, copies: p.items[0]?.copies ?? 0, ...(p.printerId ? { printerId: p.printerId } : {}) })), spacing)
        // Old slices describe plates that no longer exist.
        shared.slices.clear()
        const on = ctx.project.plates().flatMap((p) => p.items.filter((it) => it.objectId === obj.id).map((it) => ({ plate: p.index, printerId: p.printerId, copies: it.copies })))
        const moved = r.moved.map((m) => ({ objectId: m.objectId, copies: m.copies, fromPlate: m.from, toPlate: m.to }))
        const missed = leftOffWords(r)
        const said = movedWords(r.moved)
        if (missed) return { ok: false, summary: `${said ? `${said} ` : ''}${missed} The parts that fit are on the plates. To fit the rest, scale them down, cut them, or add a larger printer or more plates.`, output: { leftOff: r.leftOff, notAdded: r.notAdded ?? 0, moved } }
        const label = (index: number): string => targets[index - 1]?.label ?? targets[0]?.label ?? ''
        const vol = (index: number): BuildVolume | undefined => (targets[index - 1] ?? targets[0])?.vol
        const rows = on.map((p) => {
          const v = vol(p.plate)
          return [String(p.plate), label(p.plate), String(p.copies), v ? `${Math.round(((p.copies * ox * oy) / bedArea(v)) * 100)}%` : '']
        })
        const per = on.map((p) => p.copies)
        const head = per.every((n) => n === per[0]) ? `${per[0]} per plate on ${on.length} plate${on.length === 1 ? '' : 's'}` : `${count} copies on ${on.length} plates (${per.join(', ')})`
        const after = await checkAfter(ctx.project, ctx.project.plates().map((p) => p.index))
        return {
          summary: [said ? `${head}. ${said}` : head, after.said].filter(Boolean).join(' '),
          output: { plates: on.map((p, k) => ({ plate: p.plate, printerId: p.printerId, copies: p.copies, bedUse: rows[k]?.[3] })), moved, turns: r.turns ?? [], ...(after.check.length ? { check: after.check, leftSure: after.leftSure } : {}) },
          display: [{ kind: 'table', head: ['plate', 'printer', 'copies', 'bed use'], rows }],
        }
      }
      const laid = ctx.project?.setPlates(plates)
      const nested = await ctx.project?.arrangePlates?.(plates.map((p) => p.index), spacing)
      const set = laid || nested ? { leftOff: (laid ? laid.leftOff : 0) + (nested?.leftOff ?? 0), notAdded: (laid ? laid.notAdded ?? 0 : 0) + (nested?.notAdded ?? 0) } : undefined
      // Old slices describe plates that no longer exist.
      shared.slices.clear()
      const missed = leftOffWords(set)
      if (missed) return { ok: false, summary: `${missed} The parts that fit are on the plates. To fit the rest, scale them down, cut them, or add a larger printer or more plates.`, output: { leftOff: set ? set.leftOff : 0, notAdded: set?.notAdded ?? 0 } }
      const rows = plates.map((p, k) => {
        const t = targets[k]
        const copies = p.items[0]?.copies ?? 0
        const use = t ? Math.round(((copies * ox * oy) / bedArea(t.vol)) * 100) : 0
        return [String(p.index), t?.label ?? '', String(copies), `${use}%`]
      })
      const per = plates.map((p) => p.items[0]?.copies ?? 0)
      const after = await checkAfter(ctx.project, plates.map((p) => p.index))
      const head = per.every((n) => n === per[0]) ? `${per[0]} per plate on ${plates.length} plate${plates.length === 1 ? '' : 's'}` : `${count} copies on ${plates.length} plates (${per.join(', ')})`
      return {
        summary: after.said ? `${head}. ${after.said}` : head,
        output: { plates: plates.map((p, k) => ({ plate: p.index, printerId: p.printerId, copies: p.items[0]?.copies, bedUse: rows[k]?.[3] })), ...(after.check.length ? { check: after.check, leftSure: after.leftSure } : {}) },
        display: [{ kind: 'table', head: ['plate', 'printer', 'copies', 'bed use'], rows }],
      }
    },
  })
}
