#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Folds a package's change files (<package>/changes/*.md, one per pull request) into its CHANGELOG.md under a new
// version, and deletes them. Pull requests add a change file instead of editing CHANGELOG.md, so two of them never
// conflict on the same lines; the release that bumps the package's version runs this once:
//
//   node scripts/fold-changes.mjs packages/mcp 0.2.8                    # dated today (UTC)
//   node scripts/fold-changes.mjs packages/mcp 0.2.8 --date 2026-11-06
//   node scripts/fold-changes.mjs packages/mcp --check                  # only check the change files and CHANGELOG.md
//
// A package with scripts/tools-doc.ts (the MCP server) also gets its TOOLS.md written from its tool list in the same
// step, so the release commit carries both; --no-tools-doc skips that.
//
// A change file holds `### Added`, `### Changed`, `### Fixed` (and, rarely, `### Breaking` or `### Removed`)
// headings, each followed by the entry lines as CHANGELOG.md writes them. The version's section lists Breaking, Added,
// Changed, Removed and Fixed in that order; within a heading, the newest change file (by the commit that added it)
// comes first, as entries did when they were added at the top (run it in a full clone: a shallow one dates every file
// alike, and they fall back to name order). README.md in changes/ is not a change file and stays.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The headings a change file may use, in the order a version's section lists them. */
export const HEADINGS = ['Breaking', 'Added', 'Changed', 'Removed', 'Fixed']

/** What the Unreleased section of CHANGELOG.md says instead of listing entries. */
export const POINTER = 'Changes since the last release are in [changes/](changes/), one file per pull request. The release that bumps the version folds them in here under that version (`node scripts/fold-changes.mjs`).'

/**
 * Reads one change file into `{ heading: block }`, each block its entry lines without the blank lines around them.
 * Throws, naming the file, for text before the first heading, a heading not in HEADINGS, a heading used twice, or a
 * heading with no entry or whose first line is not a `- ` entry.
 */
export function parseChange(text, name = 'change file') {
  const sections = new Map()
  let current
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const h = /^#{1,6}\s+(.*?)\s*$/.exec(line)
    if (h) {
      const heading = h[1]
      if (!line.startsWith('### ') || !HEADINGS.includes(heading)) throw new Error(`${name}: "${line}" is not one of ${HEADINGS.map((x) => `### ${x}`).join(', ')}`)
      if (sections.has(heading)) throw new Error(`${name}: ### ${heading} appears twice`)
      current = []
      sections.set(heading, current)
    } else if (current) current.push(line)
    else if (line.trim()) throw new Error(`${name}: "${line.slice(0, 60)}" comes before the first ### heading`)
  }
  if (!sections.size) throw new Error(`${name}: no ### Added, ### Changed or ### Fixed heading`)
  const out = {}
  for (const [heading, lines] of sections) {
    while (lines.length && !lines[0].trim()) lines.shift()
    while (lines.length && !lines.at(-1).trim()) lines.pop()
    if (!lines.length) throw new Error(`${name}: ### ${heading} has no entry`)
    if (!lines[0].startsWith('- ')) throw new Error(`${name}: the first line under ### ${heading} is not a "- " entry`)
    out[heading] = lines.join('\n')
  }
  return out
}

/** The Unreleased section of `changelog`: where it starts and ends, and the text between its heading and the next. */
function unreleased(changelog) {
  const start = changelog.indexOf('\n## [Unreleased]\n')
  if (start < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" section')
  const bodyAt = start + '\n## [Unreleased]\n'.length
  const next = changelog.indexOf('\n## [', bodyAt)
  const end = next < 0 ? changelog.length : next + 1
  return { bodyAt, end, body: changelog.slice(bodyAt, end) }
}

/** Throws unless the Unreleased section of `changelog` holds only POINTER (entries go in change files). */
export function checkChangelog(changelog) {
  const { body } = unreleased(changelog)
  if (body.trim() !== POINTER) throw new Error(`the [Unreleased] section of CHANGELOG.md must hold only this line, with entries in changes/:\n${POINTER}`)
}

/**
 * CHANGELOG.md with `changes` (`{ name, text }`, newest first) folded in as `## [version] - date` right after the
 * Unreleased section, which keeps only POINTER. With no changes the section says so in one line.
 */
export function foldChanges(changelog, changes, version, date) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`"${version}" is not a version such as 0.2.8`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" is not a date such as 2026-11-06`)
  if (changelog.includes(`\n## [${version}]`)) throw new Error(`CHANGELOG.md already has a ## [${version}] section`)
  checkChangelog(changelog)
  const parsed = changes.map((c) => parseChange(c.text, c.name))
  const parts = [`## [${version}] - ${date}`, '']
  for (const heading of HEADINGS) {
    const blocks = parsed.map((p) => p[heading]).filter(Boolean)
    if (blocks.length) parts.push(`### ${heading}`, '', ...blocks, '')
  }
  if (parts.length === 2) parts.push('No changes.', '')
  const { bodyAt, end } = unreleased(changelog)
  return `${changelog.slice(0, bodyAt)}\n${POINTER}\n\n${parts.join('\n')}\n${changelog.slice(end).replace(/^\n+/, '')}`
}

/** The change files in `dir` (every .md but README.md), newest first by the commit that added each, then by name. */
export function changeFiles(dir) {
  if (!existsSync(dir)) return []
  const names = readdirSync(dir).filter((n) => n.endsWith('.md') && n !== 'README.md').sort()
  const added = (name) => {
    try {
      const out = execFileSync('git', ['log', '--diff-filter=A', '--format=%ct', '-1', '--', name], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      return out ? Number(out) : Infinity // not committed yet: newest
    } catch {
      return Infinity
    }
  }
  const when = new Map(names.map((n) => [n, added(n)]))
  return names.sort((a, b) => when.get(b) - when.get(a) || a.localeCompare(b)).map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
}

function main(args) {
  const [pkg, version] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--date')
  if (!pkg) throw new Error('usage: node scripts/fold-changes.mjs <package dir> <version> [--date YYYY-MM-DD] [--no-tools-doc] | <package dir> --check')
  const dir = resolve(pkg)
  const file = join(dir, 'CHANGELOG.md')
  const changelog = readFileSync(file, 'utf8')
  const changes = changeFiles(join(dir, 'changes'))
  if (args.includes('--check')) {
    checkChangelog(changelog)
    for (const c of changes) parseChange(c.text, c.name)
    console.log(`${pkg}: CHANGELOG.md and ${changes.length} change file${changes.length === 1 ? '' : 's'} are well formed`)
    return
  }
  if (!version) throw new Error('give the new version, such as 0.2.8')
  const i = args.indexOf('--date')
  const date = i >= 0 ? args[i + 1] : new Date().toISOString().slice(0, 10)
  writeFileSync(file, foldChanges(changelog, changes, version, date))
  for (const c of changes) rmSync(join(dir, 'changes', c.name))
  console.log(`${pkg}: folded ${changes.length} change file${changes.length === 1 ? '' : 's'} into CHANGELOG.md under ${version} (${date}) and deleted them`)
  if (existsSync(join(dir, 'scripts', 'tools-doc.ts')) && !args.includes('--no-tools-doc')) {
    const win = process.platform === 'win32'
    const r = spawnSync(win ? 'pnpm.cmd' : 'pnpm', ['exec', 'tsx', 'scripts/tools-doc.ts'], { cwd: dir, stdio: 'inherit', shell: win })
    if (r.status !== 0) throw new Error(`CHANGELOG.md is folded, but writing TOOLS.md failed: run pnpm tools-doc in ${pkg}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error(`fold-changes: ${e.message}`)
    process.exit(1)
  }
}
