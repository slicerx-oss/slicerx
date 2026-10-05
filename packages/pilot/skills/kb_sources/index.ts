// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// kb.sources: title, publisher and link for source ids the knowledge base cites.
import { z } from 'zod'
import { defineTool } from '../../src/tool'

export function createKbSources() {
  return defineTool({
    name: 'kb.sources',
    version: '1.0.0',
    source: 'kb',
    permission: 'read',
    description:
      'Look up the title, publisher and link of knowledge base sources by id (for example "bambu_wiki_ams_function") or by prefixed path (for example "orca:BBL/machine/..."). Use it when the user asks where a fact came from. Ids come from the sources field of kb tool results. Unknown ids are listed as missing.',
    input: z.object({ ids: z.array(z.string().min(1)).min(1).max(30).describe('Source ids or prefixed paths, as returned in the sources field of kb results') }),
    args: (i) => i.ids.join(' '),
    async run(i, ctx) {
      const found = ctx.kb.cite(i.ids)
      const known = new Set(found.map((c) => c.id))
      const missing = [...new Set(i.ids)].filter((id) => !known.has(id))
      const rows = found.map((c) => [c.id, c.title, c.publisher ?? '', c.url ?? ''])
      return {
        ok: found.length > 0,
        summary: `${found.length} of ${new Set(i.ids).size} sources found${missing.length ? `, ${missing.length} unknown` : ''}`,
        output: { sources: found.map((c) => ({ id: c.id, title: c.title, publisher: c.publisher ?? null, url: c.url ?? null })), missing },
        display: [{ kind: 'table', head: ['id', 'title', 'publisher', 'link'], rows }],
        citations: found,
      }
    },
  })
}
