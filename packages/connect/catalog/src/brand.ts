// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The app's name in the catalog's text. The data says "SlicerX"; a white-label edition sets its own name once at
// start and every string that names the app is rewritten in place, so readers need nothing of their own.

const NAME = 'SlicerX'

/** A place a string names the app, with the string as written. */
interface Spot {
  at: Record<string, unknown>
  key: string
  text: string
}

let spots: Spot[] | null = null

function collect(data: unknown, into: Spot[], seen: Set<object>): void {
  if (data === null || typeof data !== 'object' || seen.has(data)) return
  seen.add(data)
  const at = data as Record<string, unknown>
  for (const key of Object.keys(at)) {
    const v = at[key]
    if (typeof v === 'string') {
      if (v.includes(NAME)) into.push({ at, key, text: v })
    } else collect(v, into, seen)
  }
}

/** Sets the name the catalog's text uses for the app, in every record of `data`. */
export function brandCatalog(data: readonly unknown[], name: string): void {
  if (!spots) {
    const found: Spot[] = []
    const seen = new Set<object>()
    for (const d of data) collect(d, found, seen)
    spots = found
  }
  for (const s of spots) s.at[s.key] = s.text.replaceAll(NAME, name)
}
