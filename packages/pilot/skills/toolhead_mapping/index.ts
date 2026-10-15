// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { defineSkill } from '../../src/tool'
import type { ToolShared } from '../../src/shared'
import { exportPlate } from '../../src/tools/printers'

export function createToolheadMapping(shared: ToolShared) {
  return defineSkill({
    name: 'toolhead_mapping',
    version: '1.0.0',
    permission: 'read',
    description: 'Read the Snapmaker U1 loaded toolheads and match job filaments by material and color. Return proposed assignments, alternatives and missing materials. Pass selected to check the person\'s choices. With preparePlate, rewrite a copy of that sliced plate for those choices and retain it for a later separately approved printer.queue. All tool indices are zero based. Never uploads or starts a print.',
    input: z.object({
      printerId: z.string().min(1).describe('Connected U1 printer id'),
      preparePlate: z.number().int().min(1).optional().describe('Sliced plate number to prepare with explicit selected choices; omit to plan only'),
      needs: z.array(z.object({
        tool: z.number().int().min(0).max(31).describe('Zero-based logical tool index in the job'),
        material: z.string().min(1).describe('Required material, such as PLA or PETG-CF'),
        color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).describe('Required six-digit RGB color, optionally prefixed with #'),
      })).min(1).max(32).describe('One material and color for each logical tool used by the job'),
      selected: z.record(z.string().regex(/^(?:[0-9]|[12][0-9]|3[01])$/), z.number().int().min(0).max(3)).optional().describe('The person\'s choices: logical tool indices mapped to zero-based physical toolheads'),
    }),
    args: (i) => i.printerId,
    async run(i, ctx) {
      const plan = ctx.host.printers.planToolheads
      if (!plan) return { ok: false, summary: 'This connection does not support toolhead mapping yet' }
      const output = await plan.call(ctx.host.printers, i.printerId, i.needs, i.selected)
      if (i.preparePlate !== undefined) {
        const prepare = ctx.host.printers.prepareToolheads
        if (!prepare) return { ok: false, summary: 'This connection does not support preparing toolhead mappings yet' }
        if (!output.ready || !i.selected || Object.keys(i.selected).length !== i.needs.length) return { ok: false, summary: 'Choose a loaded toolhead for every job filament before preparing the plate', output }
        const job = await exportPlate(shared, ctx, i.preparePlate)
        const prepared = await prepare.call(ctx.host.printers, i.printerId, job.file, i.needs, i.selected)
        const entry = shared.slices.get(i.preparePlate)
        if (!entry || entry.data !== job.file.data) throw new Error('The plate changed during preparation. Review its toolhead mapping again.')
        ;(entry.preparedToolheads ??= new Map()).set(i.printerId, { sourceSha256: job.file.sha256, ...prepared })
        return { ok: true, summary: 'Prepared the toolhead mapping. Nothing was uploaded or started. Review it before approving printer.queue.', output: { ...prepared.plan, file: { name: prepared.file.name, sha256: prepared.file.sha256, sourceSha256: job.file.sha256 }, plate: i.preparePlate }, untrusted: true }
      }
      return {
        ok: true,
        summary: output.ready ? 'Toolhead choices are ready to review' : 'Choose toolheads or load the missing filament before preparing this job',
        output,
        untrusted: true,
        display: [{ kind: 'table' as const, head: ['Job filament', 'Toolhead', 'Status', 'Reason'], rows: output.assignments.map((a) => [String(a.tool + 1), a.physicalTool === null ? '' : String(a.physicalTool + 1), a.status, a.reason]) }],
      }
    },
  })
}
