// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a named value is and which names it may take, apart from the arithmetic (values.ts), so the project file
// can check names without loading the parser.

export interface NamedValue {
  name: string
  expr: string
}

export const BUILT_IN = ['clearance', 'nozzle'] as const

/** Why `name` cannot name a value, or null when it can. `taken` are the table's other names. */
export function validName(name: string, taken: readonly string[]): string | null {
  if (!/^[A-Za-z_]/.test(name)) return 'A name starts with a letter.'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'A name has only letters, digits and _.'
  if (name.length > 40) return 'A name has at most 40 characters.'
  if ((BUILT_IN as readonly string[]).includes(name)) return `${name} is built in.`
  if (taken.includes(name)) return `There is already a value named ${name}.`
  return null
}
