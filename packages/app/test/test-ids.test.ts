// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Test ids are part of the UI contract (docs/test-ids.md): every one in the app and the ui kit is listed there, and a
// control that prints, sends, deletes or archives carries a `danger-` id the agent bridge refuses, or none.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = resolve(import.meta.dirname, '../../..')
const SOURCES = [join(repo, 'packages/app/src'), join(repo, 'packages/ui/src')]
const DESTRUCTIVE = /(^|-)(delete|print|send-to|archive|erase|remove-account)(-|$)/

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
    for (const id of ['vault-detail-open', 'signin-send-again', 'account-sign-out', 'objects-list', 'export-menu', 'update-now', 'setup-next', 'upload-submit', 'creator-save']) expect(src.exact.has(id), id).toBe(true)
    expect(src.families.has('tab-*')).toBe(true)
  })

  it('lists every id in docs/test-ids.md', () => {
    const missing = [...src.exact].filter((id) => !doc.exact.has(id))
    const missingFamilies = [...src.families].filter((f) => !listed(f, doc))
    expect(missing, 'add these to docs/test-ids.md').toEqual([])
    expect(missingFamilies, 'add these families (as name-<thing>) to docs/test-ids.md').toEqual([])
  })

  it('keeps destructive actions under danger-', () => {
    const named = [...src.exact, ...src.families].filter((id) => !id.startsWith('danger-') && DESTRUCTIVE.test(id))
    expect(named).toEqual([])
  })
})
