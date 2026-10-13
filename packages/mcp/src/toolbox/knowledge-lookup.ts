// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { z } from 'zod'
import { productName } from '@slicerx/contracts'
import { ToolInputError } from '../models'
import { serverTool, type ServerToolDeps } from './deps'

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'knowledge_lookup',
    title: 'Look up print knowledge',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    toolset: 'kb',
    ungated: true,
    description:
      `Read an entry from the ${productName()} print knowledge base: filaments (temperatures, drying, plates, failure modes), printers (build volume, hotend, profile baseline), accessories, troubleshooting trees (stringing, warping, layer shift and others) and workflow guides. Every value cites sources. Omit id to list the entries of a kind.`,
    input: z.object({
      kind: z.enum(['filament', 'printer', 'accessory', 'troubleshoot', 'guide']),
      id: z.string().optional().describe('Id, name or alias, such as "petg", "Bambu Lab P1S" or "stringing"'),
    }),
    async run(args) {
      if (!args.id) {
        const entries = d.store.knowledge().filter((e) => e.kind === args.kind).map((e) => ({ id: e.id, name: e.name, uri: `slicerx://knowledge/${e.kind}/${e.id}` }))
        return { summary: `${entries.length} ${args.kind} entries`, structured: { kind: args.kind, count: entries.length, entries } }
      }
      const e = d.store.findKnowledge([args.kind], args.id)
      if (!e) throw new ToolInputError(`No ${args.kind} "${args.id}". Call slicerx_knowledge_lookup with only kind to list ids.`)
      return { summary: e.name, structured: { kind: e.kind, id: e.id, name: e.name, uri: `slicerx://knowledge/${e.kind}/${e.id}`, entry: e.data }, text: e.text }
    },
  })
