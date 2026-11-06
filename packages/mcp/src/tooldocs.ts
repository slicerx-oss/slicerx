// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// TOOLS.md, written from the one tool list: each tool's MCP name, version, title, set, permission class and first
// sentence. Pull requests leave the file alone: test/registry.test.ts checks that the doc written from the registry is
// well formed and lists every tool with its version, and the release that bumps the version writes TOOLS.md
// (scripts/tools-doc.ts, run by scripts/fold-changes.mjs). SLICERX_TOOLS_DOC_STRICT=1 makes the test compare the file
// byte for byte.
import type { PilotTool } from '@slicerx/pilot'
import { mcpName } from './gate'

const firstSentence = (s: string): string => {
  const m = /^(.+?[.!?])(\s|$)/.exec(s.replace(/\s+/g, ' ').trim())
  return (m?.[1] ?? s).replace(/\|/g, '\\|')
}

/** One row of TOOLS.md. */
export interface ToolsDocRow {
  name: string
  version: string
  title: string
  set: string
  permission: string
  about: string
}

const TITLE = '# SlicerX MCP tools'
const HEADER = '| Tool | Version | Title | Set | Permission | What it does |'
const RULE = '| --- | --- | --- | --- | --- | --- |'

/** The rows TOOLS.md lists for `tools`, sorted by MCP name. */
export function toolsDocRows(tools: readonly PilotTool<never>[]): ToolsDocRow[] {
  return [...tools]
    .map((t) => ({
      name: mcpName(t.name),
      version: t.version,
      title: (t.title ?? '').replace(/\|/g, '\\|'),
      set: t.toolset ?? '',
      permission: t.ungated ? 'read, ungated' : t.permission,
      about: firstSentence(t.description),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function toolsDoc(tools: readonly PilotTool<never>[]): string {
  const rows = toolsDocRows(tools)
  return [
    TITLE,
    '',
    'Generated from the tool list (`serverTools` in src/server.ts) with demo printers and the geometry engine on. Do not edit it by hand or in a pull request: each release writes it again (`pnpm --filter @slicerx/mcp tools-doc`), so on main it can be behind the tools a server built from main lists. The TOOLS.md of a release tag matches that release; a client reads the current list with `tools/list`.',
    '',
    `${rows.length} tools.`,
    '',
    HEADER,
    RULE,
    ...rows.map((r) => `| \`${r.name}\` | ${r.version} | ${r.title} | ${r.set} | ${r.permission} | ${r.about} |`),
    '',
  ].join('\n')
}

/** Splits a table line into its cells, keeping `\|` inside a cell. */
function cells(line: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 1; i < line.length - 1; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      cur += '\\|'
      i++
    } else if (line[i] === '|') {
      out.push(cur.trim())
      cur = ''
    } else cur += line[i]
  }
  out.push(cur.trim())
  return out
}

/**
 * Reads TOOLS.md back into its rows, and lists what makes it malformed: a missing title, count line or table header,
 * a count that is not the number of rows, a row without six cells, a name that is not a backquoted `slicerx_` name,
 * a version that is not major.minor.patch, an empty permission or description, or rows out of order or listed twice.
 */
export function parseToolsDoc(doc: string): { rows: ToolsDocRow[]; problems: string[] } {
  const problems: string[] = []
  const lines = doc.split('\n')
  if (lines[0] !== TITLE) problems.push(`the first line is not "${TITLE}"`)
  if (!doc.endsWith('\n')) problems.push('the file does not end with a newline')
  const count = lines.map((l) => /^(\d+) tools\.$/.exec(l)).find((m) => m)
  if (!count) problems.push('no "<n> tools." line')
  const at = lines.indexOf(HEADER)
  if (at < 0 || lines[at + 1] !== RULE) problems.push(`no table header "${HEADER}" with its rule line`)
  const rows: ToolsDocRow[] = []
  if (at >= 0) {
    for (const [i, line] of lines.slice(at + 2).entries()) {
      if (line === '') continue
      const n = at + 3 + i
      if (!line.startsWith('| ') || !line.endsWith(' |')) {
        problems.push(`line ${n} is not a table row`)
        continue
      }
      const c = cells(line)
      if (c.length !== 6) {
        problems.push(`line ${n} has ${c.length} cells, not 6`)
        continue
      }
      const [tool, version, title, set, permission, about] = c as [string, string, string, string, string, string]
      const name = /^`(slicerx_[a-z0-9_]+)`$/.exec(tool)?.[1]
      if (!name) problems.push(`line ${n}: ${tool} is not a backquoted slicerx_ tool name`)
      if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`line ${n}: version "${version}" is not major.minor.patch`)
      if (!permission) problems.push(`line ${n}: no permission`)
      if (!about) problems.push(`line ${n}: no description`)
      rows.push({ name: name ?? tool, version, title, set, permission, about })
    }
  }
  if (count && Number(count[1]) !== rows.length) problems.push(`it says ${count[1]} tools but lists ${rows.length}`)
  for (let i = 1; i < rows.length; i++) {
    const order = rows[i - 1]!.name.localeCompare(rows[i]!.name)
    if (order === 0) problems.push(`${rows[i]!.name} is listed twice`)
    else if (order > 0) problems.push(`${rows[i]!.name} is out of order after ${rows[i - 1]!.name}`)
  }
  return { rows, problems }
}
