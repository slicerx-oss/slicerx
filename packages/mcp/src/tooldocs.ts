// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// TOOLS.md, written from the one tool list: each tool's MCP name, title, set, permission class and first sentence.
// test/registry.test.ts fails when the file is out of date; SLICERX_WRITE_TOOLS_DOC=1 writes it again.
import type { PilotTool } from '@slicerx/pilot'
import { mcpName } from './gate'

const firstSentence = (s: string): string => {
  const m = /^(.+?[.!?])(\s|$)/.exec(s.replace(/\s+/g, ' ').trim())
  return (m?.[1] ?? s).replace(/\|/g, '\\|')
}

export function toolsDoc(tools: readonly PilotTool<never>[]): string {
  const rows = [...tools]
    .map((t) => ({ name: mcpName(t.name), title: t.title ?? '', set: t.toolset ?? '', permission: t.ungated ? 'read, ungated' : t.permission, about: firstSentence(t.description) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [
    '# SlicerX MCP tools',
    '',
    'Generated from the tool list (`serverTools` in src/server.ts) with demo printers and the geometry engine on. Do not edit by hand: `SLICERX_WRITE_TOOLS_DOC=1 pnpm --filter @slicerx/mcp exec vitest run test/registry.test.ts` writes it again.',
    '',
    `${rows.length} tools.`,
    '',
    '| Tool | Title | Set | Permission | What it does |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| \`${r.name}\` | ${r.title} | ${r.set} | ${r.permission} | ${r.about} |`),
    '',
  ].join('\n')
}
