// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which of a run's sources go under the reply: one entry per page, the ones the reply names first, a few at most.
import type { Citation } from '@slicerx/contracts'

/** The most sources a reply shows. */
export const MAX_CITED = 5
/** How many a reply that names none keeps, in the order the tools found them. */
const UNNAMED = 3

const COMMON = new Set(['about', 'after', 'guide', 'guides', 'printing', 'printer', 'printers', 'profile', 'profiles', 'settings', 'their', 'there', 'these', 'which', 'while', 'with', 'bundled', 'process', 'filament', 'project', 'community', 'research'])

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 5 && !COMMON.has(w))
}

/** Where a source points, for spotting the same page under two ids. */
function pageKey(c: Citation): string {
  if (c.url) {
    try {
      const u = new URL(c.url)
      return `${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase()
    } catch {
      // not a URL: fall back to the title
    }
  }
  return c.title.trim().toLowerCase()
}

/** How strongly the reply names a source: its publisher, then words of its title. */
function score(c: Citation, reply: string): number {
  let s = 0
  const pub = c.publisher?.toLowerCase().split(/[^a-z0-9]+/).find((w) => w.length >= 4)
  if (pub && reply.includes(pub)) s += 2
  for (const w of new Set(words(c.title))) if (reply.includes(w)) s++
  return s
}

/**
 * The sources to show under a reply: duplicates dropped, those the reply names (publisher or two title words) in
 * order of how strongly, capped at MAX_CITED. A reply that names none keeps the first few the tools found when it
 * came from looking something up (`lookedUp`), and none when the sources only rode along (a part's material weight).
 */
export function citedSources(items: readonly Citation[], replyText: string, lookedUp = true): Citation[] {
  const seen = new Set<string>()
  const unique = items.filter((c) => {
    const k = pageKey(c)
    if (seen.has(k) || seen.has(c.id)) return false
    seen.add(k)
    seen.add(c.id)
    return true
  })
  const reply = replyText.toLowerCase()
  const named = unique
    .map((c, i) => ({ c, i, s: score(c, reply) }))
    .filter((x) => x.s >= 2)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c)
  return named.length ? named.slice(0, MAX_CITED) : lookedUp ? unique.slice(0, UNNAMED) : []
}
