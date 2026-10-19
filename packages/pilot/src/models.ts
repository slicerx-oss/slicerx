// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which model a run uses. mimir has two tiers, named after Odin's ravens (design/NAMES.md):
// huginn takes quick looks (check-ins, frame reads, short answers) on a small, fast vision
// model; muninn thinks deeply (diagnosis, tune-from-failure, planning) on the large one.
import type { PilotConfig, PilotRoute } from '@slicerx/contracts'

export const HUGINN = 'huginn'
export const MUNINN = 'muninn'
export type Tier = typeof HUGINN | typeof MUNINN

/** The Model setting's default value. */
export const MODEL_AUTOMATIC = 'automatic'
/** How the setting shows the default. */
export const MODEL_AUTOMATIC_LABEL = `Automatic (${HUGINN} for quick looks, ${MUNINN} for deep thinking)`

/** Requests that need deep thinking from the start: diagnosis, tuning a profile, planning. */
const DEEP = /\b(why\b|diagnos|fail(ed|ure|s)?\b|went wrong|what happened|tune|fix (the|my|this)|profile|plan\b|planning|schedule|optimi[sz]e|compare|calibrat|by (tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|settings for)/i

/** Tools whose work needs muninn; a run that reaches one moves to muninn for the rest. */
export const MUNINN_TOOLS: ReadonlySet<string> = new Set([
  'diagnose',
  'kb.troubleshoot',
  'settings.plan',
  'settings.apply',
  'optimize_to_target',
  'compare_setups',
  'schedule',
  'calibrate',
  'resume_from_layer',
  'make_model',
  'text_to_part',
  'cut',
])

/** Failed tool results on huginn before Auto moves the rest of the run to muninn. */
export const STRUGGLE_FAILS = 2

export function tierForPrompt(prompt: string): Tier {
  return DEEP.test(prompt) ? MUNINN : HUGINN
}

/** The provider id of mimir cloud (provider/client.ts), whose proxy picks the model whatever the config routes. */
const CLOUD_PROVIDER = 'mimir-cloud'

/** The edition's routing when it applies: the person's own key, for the provider it names. */
function ownKeyRouting(config: Partial<Pick<PilotConfig, 'provider' | 'billing' | 'routing'>>): PilotConfig['routing'] {
  const r = config.routing
  if (!r || config.billing !== 'key' || config.provider === CLOUD_PROVIDER) return undefined
  return r.provider !== undefined && r.provider === config.provider ? r : undefined
}

/**
 * The model id for a tier. A pinned choice wins. `models` are the ChatGPT plan's tiers (the
 * owner's pick from the plan listing is in pilot.config.example.json). On an API key, billed
 * per token, one model does everything (`config.model`, a small one) unless the person chose
 * Auto, which uses the tiers too. The edition's routing names those models for the person's
 * own key: base for the one model and huginn, step for muninn.
 */
export function modelFor(config: Pick<PilotConfig, 'model' | 'models' | 'modelChoice' | 'billing' | 'auto'> & Partial<Pick<PilotConfig, 'provider' | 'routing'>>, tier: Tier): string {
  if (config.modelChoice && config.modelChoice !== MODEL_AUTOMATIC) return config.modelChoice
  const routed = ownKeyRouting(config)
  if (config.billing === 'key' && !config.auto) return routed?.base ?? config.model
  return (tier === MUNINN ? routed?.step : routed?.base) ?? config.models?.[tier] ?? config.model
}

const LABELS: Record<string, string> = {
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
  'gpt-6-luna': 'GPT-6 luna',
  'gpt-6-sol': 'GPT-6 sol',
}

/** How the chat names a model. */
export function modelLabel(id: string): string {
  return LABELS[id] ?? id
}

/** What a design request carries that decides its tier: the files on the message, by media type. */
export interface DesignRequestFiles {
  type: string
}

/** Feature words in a design request; each one named counts as a step of the build. */
const FEATURES: readonly RegExp[] = [
  /\bholes?\b/,
  /\bfillet(s|ed)?\b|\brounded (edges?|corners?)\b/,
  /\bchamfer(s|ed)?\b/,
  /\bslots?\b/,
  /\bboss(es)?\b/,
  /\bribs?\b/,
  /\bpockets?\b|\brecess(es|ed)?\b/,
  /\bcut-?outs?\b|\bopenings?\b/,
  /\bstandoffs?\b/,
  /\bgrooves?\b|\bchannels?\b/,
  /\blips?\b/,
  /\bflanges?\b/,
  /\blids?\b/,
  /\bhinges?\b/,
  /\bsnap(-| )?fits?\b|\bclips?\b/,
  /\bcounter(bore|sink|sunk)/,
  /\bshell(ed)?\b|\bhollow(ed)?\b/,
  /\bvents?\b/,
  /\btabs?\b/,
  /\bhandles?\b/,
  /\bengrav(e|ed|ing)\b|\bemboss(ed)?\b/,
  /\bstepped\b/,
]

/** Parts that take many features whatever the wording: teeth, threads and repeated features. */
const MANY_FEATURES = /\b(gears?|teeth|threads?|threaded|splines?|patterns?|arrays?|knurl(ed)?|lattice|honeycomb)\b/

/** Distinct features a design request names at which Auto builds it on muninn. */
export const MANY_STEPS = 4

/** How many distinct features a design request names (see FEATURES). */
export function designSteps(prompt: string): number {
  const text = prompt.toLowerCase()
  return FEATURES.filter((f) => f.test(text)).length
}

/** The tier a request starts on and why, for the run's start event and the read-back. */
export type Route = PilotRoute & { tier: Tier }
/** Why Auto started a run on its tier: deep work, a picture or PDF to build from, many steps, sizes only the person knows, or none. */
export type RouteReason = PilotRoute['reason']

/**
 * Things a person owns: "my shelf", "our cabinet door". The words after "my" that name the app's own things don't
 * count, and neither does a place the part only stands ("on my desk") or what a figure shows ("a statue of my dog").
 */
const POSSESSIVE = /\b(?:(on|at|beside|near|by|(?:statue|figurine|sculpture|bust|portrait|replica|model|toy|carving) of)\s+)?(?:my|our)\s+(?:own\s+)?([a-z][a-z-]*)/g
const APP_THINGS = new Set(['print', 'prints', 'printer', 'printers', 'profile', 'profiles', 'settings', 'filament', 'filaments', 'nozzle', 'bed', 'plate', 'ams', 'slicer', 'project', 'model', 'models', 'part', 'parts', 'design', 'designs', 'file', 'files', 'drawing', 'drawings', 'sketch', 'photo', 'picture', 'gcode', 'layer', 'layers', 'idea', 'first', 'last', 'next', 'previous', 'own'])

/** A part that mates with something that already exists: a replacement, a press fit, a holder or cap for a thing. */
const MATING =
  /\b(?:replacement|replaces?|spare|press[- ]?fits?|to fit|(?:fits?|fitting|slides?|clips?|snaps?|goes|hangs?|sits?|mounts?) (?:on|onto|over|into|in|around|between|under|inside)|(?:holder|mount|adapter|cap|lid|cover|case|sleeve|insert|plug|knob|bracket|stand|hook|clip|foot|feet|spacer) for (?:a|an|the|my|our|his|her|their)\b)/

/**
 * A named part with published sizes, which mimir looks up instead of asking: a bearing, motor, board, phone or cell by
 * its model, a metric fastener, a GoPro mount. A phone or motor without its model still needs asking which.
 */
const STANDARD =
  /\b(?:6\d{2,3}(?:-?(?:zz|2?rs))?\s+bearings?|nema\s?(?:8|11|14|17|23|34)\b|raspberry pi\s?(?:\d|zero|pico)|pi\s?[345]\b|pi zero|arduino (?:uno|nano|mega)|iphone\s?\d+|pixel\s?\d+|galaxy s\d+|18650|aaa?\s+(?:batter(?:y|ies)|cells?)|m\d{1,2}\s+(?:screws?|bolts?|nuts?|inserts?)|gopro)/

/** A size stated with its unit or as a standard fastener (40 mm, 1/2 in, 3", M3). */
const SIZE = /\b\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?\s*(?:mm|cm|in|inch|inches|"|\u2033)(?![a-z])|\bM\d{1,2}\b/gi
/** The leading sides of a size given as a box ("147.6 x 71.6 x 7.8 mm"): each counts as one more size. */
const BY = /\b\d+(?:[.,]\d+)?\s*[x\u00d7]\s*(?=\d)/g
/** A size right after the thing a part mates with is named ("a hook for a 6 mm screw"). */
const SIZED_NEXT = /^\s*(?:\d+(?:[.,]\d+)?\s*(?:mm|cm|in|inch|")|m\d{1,2}\b)/

/** Sizes stated at which a request counts as having given its own: the measured thing and how the part sits on it. */
export const SIZES_GIVEN = 3

/**
 * Whether a build needs a size only the person knows: it is for something they own ("my shelf", "our door"), or it
 * mates with an existing thing (a replacement, a press fit, a holder for a jar), and the request does not already give
 * `SIZES_GIVEN` sizes. A mate that is a standard part, or whose size follows its name, is known; so is something they
 * own that is a standard part ("my iPhone 15"). Read from the words alone, without a model call.
 */
export function personSizes(prompt: string): boolean {
  const text = prompt.toLowerCase()
  if ((text.match(SIZE) ?? []).length + (text.match(BY) ?? []).length >= SIZES_GIVEN) return false
  const mate = MATING.exec(text)
  if (mate && !STANDARD.test(text) && !SIZED_NEXT.test(text.slice(mate.index + mate[0].length))) return true
  for (const m of text.matchAll(POSSESSIVE)) {
    if (m[1] || APP_THINGS.has(m[2]!)) continue
    if (STANDARD.test(text.slice(m.index! + m[0].length - m[2]!.length))) continue
    return true
  }
  return false
}

/** Words that ask for a part to be made, in a chat without the design tools. */
const BUILD = /\b(?:make|design|model|build|create|draw|cad|print me|3d print)\b/i

const reads = (files: readonly DesignRequestFiles[]): boolean => files.some((f) => f.type.startsWith('image/') || f.type === 'application/pdf')

/**
 * Where a design request starts, and why. Auto stays on huginn unless the message carries a picture
 * or a PDF drawing to read, the part takes many steps (a gear, thread or pattern, or `MANY_STEPS` distinct features
 * named), or it needs a size only the person knows (see personSizes). Tool calls never move a design run, and neither
 * do failed ones: the build stays on the tier it started on.
 */
export function designRoute(prompt: string, files: readonly DesignRequestFiles[] = []): Route {
  if (reads(files)) return { tier: MUNINN, reason: 'attachment' }
  if (MANY_FEATURES.test(prompt.toLowerCase()) || designSteps(prompt) >= MANY_STEPS) return { tier: MUNINN, reason: 'many_steps' }
  if (personSizes(prompt)) return { tier: MUNINN, reason: 'person_sizes' }
  return { tier: HUGINN, reason: 'default' }
}

/** The tier a design request starts on (see designRoute). */
export function designTier(prompt: string, files: readonly DesignRequestFiles[] = []): Tier {
  return designRoute(prompt, files).tier
}

/**
 * Where a request starts in the mimir tab, which designs and slices in one conversation, and why: muninn for deep work
 * (a failure to diagnose, a profile to tune, a job to plan; see tierForPrompt), else as designRoute decides for a build.
 * Chat that builds nothing names no features and nothing of the person's, so it stays on huginn.
 */
export function tabRoute(prompt: string, files: readonly DesignRequestFiles[] = []): Route {
  if (tierForPrompt(prompt) === MUNINN) return { tier: MUNINN, reason: 'deep' }
  return designRoute(prompt, files)
}

/**
 * Where a request starts in a chat without the design tools, and why: muninn for deep work (see tierForPrompt), and for a build from a
 * picture or PDF or one that needs a size only the person knows, so the model that decides what to ask is the larger
 * one. Any other request starts on huginn; a part tool or failures can still move the run up later.
 */
export function chatRoute(prompt: string, files: readonly DesignRequestFiles[] = []): Route {
  if (tierForPrompt(prompt) === MUNINN) return { tier: MUNINN, reason: 'deep' }
  if (BUILD.test(prompt)) {
    if (reads(files)) return { tier: MUNINN, reason: 'attachment' }
    if (personSizes(prompt)) return { tier: MUNINN, reason: 'person_sizes' }
  }
  return { tier: HUGINN, reason: 'default' }
}
