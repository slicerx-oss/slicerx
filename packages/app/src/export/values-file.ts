// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The project's named values in a project file: Metadata/slicerx_values.json, `{ "version": 1, "values": [{ "name",
// "expr" }] }` (docs/cad-history.md, "Named values"). Other slicers ignore the part. Read as untrusted: a newer
// version, a bad name, a built-in, a repeat or an over-long expression is left out.
import { validName, type NamedValue } from '../cad/value-names'

const MAX_VALUES = 200
const MAX_EXPR = 200

/** The part's text, or null when the table is empty so nothing is added. */
export function valuesJson(values: readonly NamedValue[]): string | null {
  return values.length ? JSON.stringify({ version: 1, values: values.map(({ name, expr }) => ({ name, expr })) }, null, 2) : null
}

export function parseValues(files: ReadonlyMap<string, Uint8Array>): NamedValue[] {
  const bytes = files.get('Metadata/slicerx_values.json')
  if (!bytes) return []
  let j: unknown
  try {
    j = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return []
  }
  if (typeof j !== 'object' || j === null || (j as { version?: unknown }).version !== 1) return []
  const list = (j as { values?: unknown }).values
  if (!Array.isArray(list)) return []
  const out: NamedValue[] = []
  for (const v of list.slice(0, MAX_VALUES)) {
    if (typeof v !== 'object' || v === null) continue
    const { name, expr } = v as { name?: unknown; expr?: unknown }
    if (typeof name !== 'string' || typeof expr !== 'string' || expr.length > MAX_EXPR) continue
    if (validName(name, out.map((o) => o.name)) !== null) continue
    out.push({ name, expr })
  }
  return out
}
