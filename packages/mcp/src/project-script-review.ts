// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ScriptIdentity, ScriptReviewInput } from '@slicerx/contracts'
import { GCODE_TEXT_KEYS, printerConfig, scriptDeclarations } from '@slicerx/settings'
import { slicePrinter, type ExtraLayers } from './config'
import type { ProfileCatalog } from './profiles'
import type { SlicerBackend } from './slicer'
import { ToolInputError } from './models'

/** Selects only from explicit profile layers; imported names are conflicting declarations, not a selection. */
export async function reviewProjectScripts(profiles: ProfileCatalog, names: string[], extra: ExtraLayers, overrides: Record<string, unknown> | undefined, slicer: SlicerBackend, explicitTarget?: ScriptIdentity): Promise<NonNullable<ExtraLayers['scriptReviews']>> {
  if (!extra.project || !slicer.reviewScripts) return []
  const target = slicePrinter(profiles, names, extra.presets ?? [])
  if (!target && !explicitTarget) return []
  const model = explicitTarget?.model ?? target!.printerId
  const stock = printerConfig(model) as Record<string, unknown> | undefined
  const firmware = explicitTarget?.firmware ?? (typeof stock?.gcode_flavor === 'string' ? stock.gcode_flavor : '')
  const selected: ScriptIdentity = { model, firmware }
  const declared: ScriptIdentity[] = []
  const declare = (config: Record<string, unknown>, model?: string) => {
    declared.push(...scriptDeclarations(config, selected, model))
  }
  declare(extra.project.config, extra.project.model)
  for (const name of names) {
    const profile = profiles.get(name)
    if (profile?.section === 'printer') declare(profile.config, profiles.printerModel(name))
  }
  for (const preset of extra.presets ?? []) if (preset.section === 'printer') declare({ ...preset.values, inherits: preset.inherits ?? preset.name })
  if (overrides) declare(overrides)
  const later = [
    ...names.map((name) => profiles.get(name)?.config ?? {}),
    ...(extra.presets ?? []).map((preset) => preset.values),
    ...(extra.slots ?? []).map((slot) => slot.values),
    overrides ?? {},
  ]
  const replaced = new Set(later.flatMap((layer) => Object.keys(layer)))
  const entries = Object.entries(extra.project.config).filter(([key]) => GCODE_TEXT_KEYS.includes(key) && !replaced.has(key)).flatMap(([key, value]) =>
    (Array.isArray(value) ? value : [value]).flatMap((text, slot) => typeof text === 'string' && text.trim() ? [{ key, ...(Array.isArray(value) ? { slot } : {}), text }] : []))
  const inputs: ScriptReviewInput[] = entries.map(({ key, text }) => ({ selected, declared, key, text }))
  let reviews
  try { reviews = await slicer.reviewScripts(inputs) } catch (error) {
    if (!(error instanceof ToolInputError) || error.code !== 'engine_unavailable') throw error
    return entries.map((entry) => ({ ...entry, review: { schemaVersion: 1, decision: 'review', reason: 'script_review_unavailable', identity: selected, source: null, stockVersion: null, fingerprint: null, ignored: [] } }))
  }
  if (reviews.length !== entries.length) throw new Error('Script review count differs from the imported script count')
  return entries.map((entry, i) => ({ ...entry, review: reviews[i]! }))
}
