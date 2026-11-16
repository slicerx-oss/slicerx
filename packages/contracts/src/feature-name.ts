// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How a plan feature's name is compared with a step's tag: lower case, words only, plurals made single. design.check
// counts a feature as built by a step tagged with its name this way, and the note that a plan is not finished reads
// the steps with the same rule, so the two never disagree about what is built.

/** Plurals the rules below get wrong: an f that turns to ves, and axes, the plural of axis. */
const PLURALS: Record<string, string> = { shelves: 'shelf', halves: 'half', axes: 'axis' }

/** A word made single: "holes" is "hole", "boxes" is "box", "assemblies" is "assembly", "shelves" is "shelf"; "glass", "axis" and "chassis" stay. */
export function single(w: string): string {
  const odd = PLURALS[w]
  if (odd) return odd
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 4 && /(?:ch|sh|ss|x|z)es$/.test(w)) return w.slice(0, -2)
  return w.length > 3 && w.endsWith('s') && !/(?:ss|is)$/.test(w) ? w.slice(0, -1) : w
}

/** A feature name or tag as compared: lower case, words only, plurals made single ("Snap-fit lids" is "snap fit lid"). */
export function nameKey(name: string): string {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(single).join(' ')
}
