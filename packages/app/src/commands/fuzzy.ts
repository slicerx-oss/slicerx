// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Subsequence fuzzy matching for the command bar. Allocation-free per candidate
// so filtering 500 commands stays well under one frame.

/** Score of `query` against `text`, or -1 when it is not a subsequence. Higher is better. */
export function fuzzyScore(query: string, text: string): number {
  if (query.length === 0) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const direct = t.indexOf(q)
  if (direct >= 0) {
    // Contiguous hits win; a hit at a word start beats one inside a word.
    const atWord = direct === 0 || t.charCodeAt(direct - 1) === 32
    return 1000 - direct + (atWord ? 200 : 0) - (t.length - q.length) * 0.5
  }
  let score = 0
  let ti = 0
  let run = 0
  let prev = -2
  for (let qi = 0; qi < q.length; qi++) {
    const c = q.charCodeAt(qi)
    if (c === 32) continue
    let found = -1
    while (ti < t.length) {
      if (t.charCodeAt(ti) === c) {
        found = ti
        ti++
        break
      }
      ti++
    }
    if (found < 0) return -1
    const wordStart = found === 0 || t.charCodeAt(found - 1) === 32
    run = found === prev + 1 ? run + 1 : 0
    score += 10 + run * 6 + (wordStart ? 14 : 0) - Math.min(found - prev - 1, 8)
    prev = found
  }
  return score - t.length * 0.2
}

/** Best score over a title and its keywords; keywords count a little less. */
export function scoreCommand(query: string, title: string, keywords: readonly string[] | undefined): number {
  let best = fuzzyScore(query, title)
  if (keywords) {
    for (const k of keywords) {
      const s = fuzzyScore(query, k) - 40
      if (s > best) best = s
    }
  }
  return best
}
