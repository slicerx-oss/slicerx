// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Test ids are part of the UI contract (docs/test-ids.md): every one in the app and the ui kit is listed there, and a
// control that prints, sends, deletes, archives, publishes, installs an update or cancels carries a `danger-` id the
// agent bridge refuses, or none, unless it is one of the documented exceptions.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = resolve(import.meta.dirname, '../../..')
const SOURCES = [join(repo, 'packages/app/src'), join(repo, 'packages/ui/src')]
const DESTRUCTIVE = /(^|-)(delete|print|send-to|archive|erase|remove-account|publish|update|cancel)(-|$)/

/**
 * Ids that carry one of those words and still name no destructive act, each with the reason. docs/test-ids.md lists
 * the same ids under "Exceptions to the danger- rule".
 */
const EXCEPTIONS: Record<string, string> = {
  'upload-publish': 'the release gate publishes its own test design; nothing goes live before a person approves it in review',
  'unsaved-cancel': 'closes Save changes first? and keeps everything as it is',
  'upload-cancel': 'closes the upload form; nothing was sent',
  'creator-cancel': 'closes the creator page editor without saving',
  'model-tool-cancel': 'closes a modeling tool; what was applied stays, nothing more is undone',
  'update-sheet': 'the update sheet itself',
  'update-body': 'the sheet body, read for its step',
  'update-download': 'opens the download page for a package install; nothing is installed',
  'update-later': 'closes the sheet without updating',
  'update-quit': 'quits the app when an update is required, without installing anything',
  'update-retry': 'checks for the update again',
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p) : n.endsWith('.tsx') ? [p] : []
  })
}

/** A family's shape with its variable parts as `*`: `tab-${t.id}` and `tab-<workspace>` are both `tab-*`. */
const family = (t: string) => t.replace(/\$\{[^}]*\}|<[^>]*>/g, '*')

/** Ids in the source: plain ones, and families from template strings (`creator-${kind}-file`). */
function sourceIds(): { exact: Set<string>; families: Set<string> } {
  const exact = new Set<string>()
  const families = new Set<string>()
  for (const f of SOURCES.flatMap(files)) {
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(/data-testid="([^"]+)"|testId(?:=|: )["']([^"']+)["']/g)) exact.add((m[1] ?? m[2])!)
    for (const m of text.matchAll(/data-testid=\{`([^`]+)`\}/g)) families.add(family(m[1]!))
  }
  return { exact, families }
}

/** The test ids the release gate (scripts/gate) uses by name. */
function gateIds(): string[] {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.mjs') && !p.endsWith('.test.mjs') ? [p] : []
    })
  const ids = new Set<string>()
  for (const f of walk(join(repo, 'scripts/gate'))) {
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(/(?:\.(?:click|one|element|waitFor|fill)\(|visible\(|ids\(\)\)\[|ids\[)\s*'([a-z0-9]+(?:-[a-z0-9]+)+)'/g)) ids.add(m[1]!)
  }
  return [...ids].sort()
}

/** Ids on the page: `name` entries, and `name-<thing>` families. */
function documented(): { exact: Set<string>; families: Set<string> } {
  const doc = readFileSync(join(repo, 'docs/test-ids.md'), 'utf8')
  const exact = new Set<string>()
  const families = new Set<string>()
  for (const m of doc.matchAll(/`([a-z0-9][a-z0-9<>-]*)`/g)) (m[1]!.includes('<') ? families : exact).add(m[1]!.includes('<') ? family(m[1]!) : m[1]!)
  return { exact, families }
}

/** A family is listed as a family, or as each of its members. */
function listed(fam: string, doc: { exact: Set<string>; families: Set<string> }): boolean {
  if (doc.families.has(fam)) return true
  const re = new RegExp(`^${fam.split('*').map((s) => s.replace(/[.]/g, '\\$&')).join('[a-z0-9-]+')}$`)
  return [...doc.exact].some((id) => re.test(id))
}

describe('test ids', () => {
  const src = sourceIds()
  const doc = documented()

  it('finds the ids the release gate uses', () => {
    // Every id scripts/gate names in a click, fill, read or wait, so a rename here fails until the gate follows.
    const gate = gateIds()
    expect(gate.length).toBeGreaterThan(40)
    const missing = gate.filter((id) => !src.exact.has(id) && ![...src.families].some((f) => new RegExp(`^${f.split('*').join('[a-z0-9-]+')}$`).test(id)))
    expect(missing, 'rename these in scripts/gate too').toEqual([])
    for (const id of ['vault-detail-open', 'update-later', 'upload-publish', 'projects-close']) expect(src.exact.has(id), id).toBe(true)
    expect(src.families.has('tab-*')).toBe(true)
  })

  it('lists every id in docs/test-ids.md', () => {
    const missing = [...src.exact].filter((id) => !doc.exact.has(id))
    const missingFamilies = [...src.families].filter((f) => !listed(f, doc))
    expect(missing, 'add these to docs/test-ids.md').toEqual([])
    expect(missingFamilies, 'add these families (as name-<thing>) to docs/test-ids.md').toEqual([])
  })

  it('keeps destructive actions under danger-', () => {
    const named = [...src.exact, ...src.families].filter((id) => !id.startsWith('danger-') && DESTRUCTIVE.test(id) && !(id in EXCEPTIONS))
    expect(named, 'name these danger-, or add a documented exception').toEqual([])
    for (const id of ['danger-update-now', 'danger-update-restart']) expect(src.exact.has(id), id).toBe(true)
  })

  it('lists each exception to the danger- rule in docs/test-ids.md, and only those', () => {
    const doc = readFileSync(join(repo, 'docs/test-ids.md'), 'utf8')
    const section = doc.split(/^## /m).find((s) => s.startsWith('Exceptions to the danger- rule'))
    expect(section, 'docs/test-ids.md needs the section "Exceptions to the danger- rule"').toBeDefined()
    const listed = [...section!.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]!)
    expect(listed.sort()).toEqual(Object.keys(EXCEPTIONS).sort())
    for (const id of listed) {
      expect(src.exact.has(id), `${id} is no longer in the source; drop the exception`).toBe(true)
      expect(DESTRUCTIVE.test(id), `${id} needs no exception`).toBe(true)
    }
  })
})
