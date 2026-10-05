// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { NEUTRAL_EDITION } from './defaults.ts'
import { mergeLayers } from './merge.ts'
import { editionConfigSchema, type EditionConfig, type EditionConfigInput } from './schema.ts'

/** A config layer: any subset of the schema's input. Layers merge over the one they extend. */
export type EditionConfigLayer = { [K in keyof EditionConfigInput]?: EditionConfigInput[K] extends object ? DeepPartial<EditionConfigInput[K]> : EditionConfigInput[K] }
type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

export class EditionConfigError extends Error {
  readonly issues: { path: string; message: string }[]
  constructor(issues: { path: string; message: string }[]) {
    super('Invalid edition config:\n' + issues.map((i) => `  ${i.path || '(root)'}: ${i.message}`).join('\n'))
    this.issues = issues
    this.name = 'EditionConfigError'
  }
}

/** Validates without throwing. */
export function checkEditionConfig(input: unknown): { ok: true; config: EditionConfig } | { ok: false; issues: { path: string; message: string }[] } {
  const r = editionConfigSchema.safeParse(input)
  if (r.success) return { ok: true, config: Object.freeze(r.data) as EditionConfig }
  return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }
}

/** Parses a finished config (all layers already merged) and fills defaults. Throws EditionConfigError. */
export function parseEditionConfig(input: unknown): EditionConfig {
  const r = checkEditionConfig(input)
  if (!r.ok) throw new EditionConfigError(r.issues)
  return r.config
}

/**
 * For config files: merges `layer` over `opts.extends` (default: the neutral base edition) and validates.
 *
 *   export default defineEditionConfig({ id: 'forge', brand: { name: 'Forge' }, ... })
 */
export function defineEditionConfig(layer: EditionConfigLayer, opts: { extends?: EditionConfigInput | EditionConfig } = {}): EditionConfig {
  return parseEditionConfig(mergeLayers(opts.extends ?? NEUTRAL_EDITION, layer))
}
