// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a description sits in a tool's input schema, written as a path a person can read in a table: property names
// joined with dots, [] for an array's items and {} for a map's values, with the branches of a union, an intersection
// or a condition at the same path as the node they belong to, and a definition under $defs.<name>. The root is ''.
// local-tools.ts lists, by these paths, the field descriptions a local model is sent.

type Visit = (node: Record<string, unknown>, path: string) => void

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const under = (path: string, key: string): string => (path ? `${path}.${key}` : key)

function walk(node: unknown, path: string, visit: Visit): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, path, visit)
    return
  }
  if (!isRecord(node)) return
  visit(node, path)
  for (const [k, v] of Object.entries(node)) {
    if (k === 'properties' && isRecord(v)) for (const [p, s] of Object.entries(v)) walk(s, under(path, p), visit)
    else if (k === 'patternProperties' && isRecord(v)) for (const s of Object.values(v)) walk(s, `${path}{}`, visit)
    else if ((k === '$defs' || k === 'definitions') && isRecord(v)) for (const [p, s] of Object.entries(v)) walk(s, `$defs.${p}`, visit)
    else if (k === 'items' || k === 'prefixItems' || k === 'additionalItems' || k === 'contains') walk(v, `${path}[]`, visit)
    else if (k === 'additionalProperties' || k === 'propertyNames') walk(v, `${path}{}`, visit)
    else if (k === 'anyOf' || k === 'oneOf' || k === 'allOf' || k === 'not' || k === 'if' || k === 'then' || k === 'else') walk(v, path, visit)
  }
}

/** The paths in `schema` whose node carries a description, sorted and without repeats. */
export function describedPaths(schema: unknown): string[] {
  const found = new Set<string>()
  walk(schema, '', (node, path) => {
    if (typeof node.description === 'string') found.add(path)
  })
  return [...found].sort()
}

/** A copy of `schema` keeping a node's description only where its path is in `keep`; nothing else changes. */
export function keepDescriptions(schema: unknown, keep: ReadonlySet<string>): unknown {
  const copy = structuredClone(schema)
  walk(copy, '', (node, path) => {
    if (typeof node.description === 'string' && !keep.has(path)) delete node.description
  })
  return copy
}
