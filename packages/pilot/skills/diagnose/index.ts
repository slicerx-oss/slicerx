// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Explains a failed print from the printer's status and the troubleshooting
// guides. Printer text is untrusted and passed on as data.
import type { Cell } from '@slicerx/contracts'
import { z } from 'zod'
import { defineSkill } from '../../src/tool'

export function createDiagnose() {
  return defineSkill({
    name: 'diagnose',
    version: '0.8.5',
    permission: 'read',
    description: 'Explain a failed or odd print on one of your printers: reads its status and message, matches the symptom against the troubleshooting guides and ranks causes with checks and fixes.',
    input: z.object({
      printerId: z.string().optional(),
      symptom: z.string().min(2).describe('What the user saw, such as "layer shift at layer 212"'),
    }),
    args: (i) => `${i.printerId ?? ''} "${i.symptom}"`.trim(),
    async run(i, ctx) {
      const status = i.printerId ? await ctx.host.printers.status(i.printerId).catch(() => null) : null
      const info = i.printerId ? (await ctx.host.printers.list()).find((p) => p.id === i.printerId) : undefined
      const family = info ? `${info.vendor} ${info.plugin}`.toLowerCase() : ''
      const query = `${i.symptom} ${status?.message ?? ''}`
      const hit = ctx.kb.search(query, { kinds: ['troubleshoot'], limit: 2 })
      const guide = hit[0]?.doc
      const causes = Array.isArray(guide?.data['causes']) ? (guide?.data['causes'] as Record<string, unknown>[]) : []
      const rank: Record<string, number> = { high: 0, medium: 1, low: 2 }
      const fits = (c: Record<string, unknown>): boolean => {
        const ps = c['printers']
        if (!Array.isArray(ps) || !family) return true
        return ps.some((p) => family.includes(String(p)) || (p === 'klipper' && family.includes('moonraker')))
      }
      const ranked = causes.filter(fits).sort((a, b) => (rank[String(a['likelihood'])] ?? 3) - (rank[String(b['likelihood'])] ?? 3))
      const rows: Cell[][] = ranked.slice(0, 5).map((c) => [String(c['name'] ?? c['id']), { text: String(c['likelihood'] ?? ''), tone: c['likelihood'] === 'high' ? 'warn' : 'dim' }])
      return {
        summary: guide ? `${guide.name}: ${ranked.length} candidate causes${status ? `, printer ${status.state}` : ''}` : 'No matching troubleshooting guide',
        ok: Boolean(guide),
        output: {
          printer: status ? { state: status.state, job: status.jobName, layer: status.layer, layerCount: status.layerCount, message: status.message } : null,
          guide: guide ? { id: guide.id, name: guide.name, tree: guide.data['tree'], causes: ranked.slice(0, 5) } : null,
          note: 'Camera snapshots are not analyzed by this skill yet; ask the user what they see when the tree needs it.',
        },
        untrusted: Boolean(status?.message),
        display: rows.length ? [{ kind: 'table', head: ['cause', 'likelihood'], rows }] : [],
        citations: guide ? ctx.kb.cite(guide.sources) : [],
      }
    },
  })
}
