// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings a project's printer G-code reads that the schema does not model. The engine reads a script's placeholders
// from the whole config it is given, so `sx slice <project.3mf>`, which slices with every key the file holds, renders a
// script that names one of them. A slice built from the imported settings has only the keys the schema knows, so the
// project's value for each such key a kept script names goes along with it, as the file has it.
import { SCRIPT_KEYS } from './script-values'

const WORD = /[A-Za-z_][A-Za-z0-9_]*/g

/** The names a G-code template reads: every word in a `{...}` block outside quotes, and each `[name]` placeholder. */
export function scriptNames(text: string): Set<string> {
  const out = new Set<string>()
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '{') {
      let depth = 1
      let j = i + 1
      for (; j < text.length && depth > 0; j++) {
        if (text[j] === '{') depth++
        else if (text[j] === '}') depth--
      }
      // Quoted text in an expression is a value, not a name.
      for (const m of text.slice(i + 1, j - 1).replace(/"[^"]*"/g, ' ').matchAll(WORD)) out.add(m[0])
      i = j
    } else if (c === '[') {
      const m = /^\[([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i, i + 256))
      if (m) out.add(m[1]!)
      i++
    } else i++
  }
  return out
}

/** Keys the printer layer fills from each slot's filament (script-values.ts): the file's own value is the closer one. */
const FILLED = new Set<string>(SCRIPT_KEYS)

/**
 * The entries of `unmodeled` (a project's values for keys the schema has no setting for, as the file holds them) that a
 * G-code text in `config` (any `*_gcode` key) names and `config` itself does not hold, or holds only as the printer
 * layer's per-slot fill. It reads no schema, so the app's slice can use it without loading the settings catalog.
 */
export function scriptKeyValues<T>(config: Readonly<Record<string, unknown>>, unmodeled: Readonly<Record<string, T>>): Record<string, T> {
  const keys = Object.keys(unmodeled).filter((k) => config[k] === undefined || FILLED.has(k))
  if (keys.length === 0) return {}
  const named = new Set<string>()
  for (const [key, v] of Object.entries(config)) {
    if (!key.endsWith('_gcode')) continue
    for (const text of Array.isArray(v) ? v : [v]) if (typeof text === 'string' && text) for (const n of scriptNames(text)) named.add(n)
  }
  return Object.fromEntries(keys.filter((k) => named.has(k)).map((k) => [k, unmodeled[k]!]))
}
