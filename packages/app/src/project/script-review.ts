// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ScriptIdentity, ScriptReview, SlicerHost } from '@slicerx/contracts'
import { GCODE_TEXT_KEYS, importFlat, printerConfig, scriptDeclarations } from '@slicerx/settings'
import { provideScriptRecognition } from './script-recognition'

export interface ProjectScriptReview {
  key: string
  slot?: number
  text: string
  review: ScriptReview
}

/** A saved engine result applies only to the same complete value and current printer identity. */
export function recognizedScript(key: string, value: unknown, model: string | undefined, overrides: Record<string, unknown>, records: readonly ProjectScriptReview[]): boolean {
  if (!model) return false
  const flavor = overrides.gcode_flavor ?? printerConfig(model)?.gcode_flavor
  const flavors = Array.isArray(flavor) ? flavor : [flavor]
  if (!flavors.length || flavors.some((value) => typeof value !== 'string')) return false
  const identity = { model, firmware: flavors[0] as string }
  if (scriptDeclarations(overrides, identity).some((declared) => declared.model !== model || declared.firmware !== identity.firmware)) return false
  const values = Array.isArray(value) ? value : [value]
  if (values.some((text) => typeof text !== 'string')) return false
  const entries = values.map((text, slot) => ({ text, slot: Array.isArray(value) ? slot : undefined })).filter(({ text }) => text.trim())
  return entries.length > 0 && entries.every(({ text, slot }) => records.some((record) =>
    record.key === key && record.slot === slot && record.text === text && record.review.identity?.model === model &&
    flavors.every((flavor) => record.review.identity?.firmware === flavor) && record.review.source && record.review.stockVersion && record.review.fingerprint &&
    (record.review.decision === 'exact' || record.review.decision === 'cosmetic')))
}

provideScriptRecognition(recognizedScript)

/** How long the open waits for the engine's script review before it goes on without one. */
const REVIEW_WAIT_MS = 15_000

/** Read-back only. The caller supplies the selection made before importing the project's printer names. */
export async function reviewImportedScripts(slicer: SlicerHost, settings: Record<string, unknown>, selected: ScriptIdentity | null): Promise<ProjectScriptReview[]> {
  const project = importFlat(Object.fromEntries(Object.entries(settings).filter(([key]) => GCODE_TEXT_KEYS.includes(key)))).config
  const entries = Object.entries(project).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).flatMap((text, slot) =>
    typeof text === 'string' && text.trim() ? [{ key, ...(Array.isArray(value) ? { slot } : {}), text }] : []))
  if (!entries.length) return []
  // No review (an engine without it, an error, a missing or short answer, or none in time) leaves the scripts unreviewed:
  // they wait for the person at the next slice, and the project's settings still apply.
  const unreviewed = (): ProjectScriptReview[] => entries.map((entry) => ({ ...entry, review: {
    schemaVersion: 1, decision: 'review', reason: 'script_review_unavailable', identity: selected,
    source: null, stockVersion: null, fingerprint: null, ignored: [],
  } }))
  if (!slicer.reviewScripts) return unreviewed()
  const declared = selected ? scriptDeclarations(settings, selected) : []
  let timer: ReturnType<typeof setTimeout> | undefined
  const reviews = await Promise.race([
    (async () => slicer.reviewScripts!(entries.map(({ key, text }) => ({ selected, declared, key, text }))))().catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), REVIEW_WAIT_MS) }),
  ]).finally(() => clearTimeout(timer))
  if (!Array.isArray(reviews) || reviews.length !== entries.length) return unreviewed()
  return entries.map((entry, index) => ({ ...entry, review: reviews[index]! }))
}
