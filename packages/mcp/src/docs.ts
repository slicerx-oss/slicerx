// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Integrator docs served as MCP resources, so an AI client can read how to
// install, embed, theme and connect SlicerX and build on its engine: the install,
// embedding and build-on-the-engine guides,
// the UI and viewport theming guides, the printer and Home Assistant guides,
// this server's README, and a settings reference built from the schema.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import type { DataPaths, DataStore } from './data'

export interface DocEntry {
  /** Resource id: `install`, `theming-ui`, `printers/moonraker` and so on. */
  id: string
  title: string
  path: string
}

function title(file: string, fallback: string): string {
  const first = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('# '))
  return first ? first.slice(2).trim() : fallback
}

function markdownIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...markdownIn(full))
    else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

/** Every doc that exists in this checkout or package; missing ones are simply not listed. */
export function listDocs(paths: DataPaths): DocEntry[] {
  const repo = paths.layout === 'repo'
  const r = (...p: string[]): string => join(paths.root, ...p)
  const fixed: [string, string][] = repo
    ? [
        ['install', r('docs', 'install.md')],
        ['embedding', r('docs', 'embedding.md')],
        ['build-on-the-engine', r('docs', 'build-on-the-engine.md')],
        ['theming-ui', r('packages', 'ui', 'THEMING.md')],
        ['theming-viewport', r('packages', 'ui', 'viewport', 'THEMING.md')],
        ['mcp', r('packages', 'mcp', 'README.md')],
        ['integrators/agents', r('docs', 'integrators', 'AGENTS.md')],
        ['integrators/quickstart', r('docs', 'integrators', 'quickstart.md')],
      ]
    : [
        ['install', r('docs', 'install.md')],
        ['embedding', r('docs', 'embedding.md')],
        ['build-on-the-engine', r('docs', 'build-on-the-engine.md')],
        ['theming-ui', r('docs', 'theming-ui.md')],
        ['theming-viewport', r('docs', 'theming-viewport.md')],
        ['mcp', r('docs', 'mcp.md')],
        ['integrators/agents', r('docs', 'integrators', 'AGENTS.md')],
        ['integrators/quickstart', r('docs', 'integrators', 'quickstart.md')],
      ]
  const docs: DocEntry[] = fixed.filter(([, p]) => existsSync(p)).map(([id, p]) => ({ id, title: title(p, id), path: p }))
  const settingsDir = repo ? r('packages', 'settings', 'docs') : r('docs', 'settings')
  for (const file of markdownIn(settingsDir)) {
    const id = `settings/${relative(settingsDir, file).split(sep).join('/').replace(/\.md$/, '')}`
    docs.push({ id, title: title(file, basename(file, '.md')), path: file })
  }
  const printerDir = repo ? r('packages', 'connect', 'docs') : r('docs', 'printers')
  for (const file of markdownIn(printerDir)) {
    const id = `printers/${relative(printerDir, file).split(sep).join('/').replace(/\.md$/, '')}`
    docs.push({ id, title: title(file, basename(file, '.md')), path: file })
  }
  return docs
}

/**
 * The reference entry for one key: the "### `key`" block in the group file
 * reference/<section>-<group>.md published by the settings package.
 */
export function settingEntry(paths: DataPaths, section: string, group: string, key: string): string | undefined {
  const base = paths.layout === 'repo' ? join(paths.root, 'packages', 'settings', 'docs', 'reference') : join(paths.root, 'docs', 'settings', 'reference')
  const file = join(base, `${section}-${group}.md`)
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8')
  const start = text.indexOf(`### \`${key}\``)
  if (start < 0) return undefined
  const next = text.indexOf('\n### ', start + 4)
  return text.slice(start, next < 0 ? undefined : next).trim()
}

/** Markdown reference of every setting, grouped by section and group. Used when the published reference is not installed. */
export function settingsReference(store: DataStore): string {
  const lines = ['# SlicerX settings reference', '', 'Every OrcaSlicer setting SlicerX reads, with its unit, default and limits. Keys are OrcaSlicer names.', '']
  const bySection = new Map<string, Map<string, typeof defs>>()
  const defs = [...store.settingsSchema()]
  for (const d of defs) {
    const groups = bySection.get(d.section) ?? new Map<string, typeof defs>()
    const list = groups.get(d.group) ?? []
    list.push(d)
    groups.set(d.group, list)
    bySection.set(d.section, groups)
  }
  for (const [section, groups] of bySection) {
    lines.push(`## ${section[0]?.toUpperCase() ?? ''}${section.slice(1)}`, '')
    for (const [group, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`### ${group}`, '', '| Key | Label | Unit | Default | Range |', '| --- | --- | --- | --- | --- |')
      for (const d of list.sort((a, b) => a.key.localeCompare(b.key))) {
        const range = d.min !== undefined || d.max !== undefined ? `${d.min ?? ''} to ${d.max ?? ''}` : d.enumValues ? d.enumValues.slice(0, 6).join(', ') + (d.enumValues.length > 6 ? ', ...' : '') : ''
        lines.push(`| \`${d.key}\` | ${d.label.replace(/\|/g, '/')} | ${d.unit ?? ''} | ${JSON.stringify(d.default).slice(0, 40).replace(/\|/g, '/')} | ${range} |`)
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}
