// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which tools one turn sends a local model in the mimir tab. A local model's whole context is MIMIR_CONTEXT tokens
// (context.ts), and the tab's tools alone measure well over that, so the system prompt would be cut off. Each turn
// sends the tools every turn needs and one set picked for it: building a new part, shaping one, editing one, the app
// (slicing, settings, the project, the knowledge base and the app's commands), or the printers. The set is
// read from the request's words and whether there is a design to shape yet; a request with no such words keeps the
// chat's last set. A model that needs a tool of
// another set loads it with pilot.tools, and calling a tool of another set loads that set for the next step, so a
// turn never gets stuck without a tool. A cloud model is not affected: every turn sends every tool, up to the
// provider's tool limit (toolsets.ts).
import type { PilotAttachment } from '@slicerx/contracts'
import { z } from 'zod'
import { toolGroupOf, type GroupedTool } from './surfaces'
import { defineTool, type PilotTool } from './tool'

/** The sets a local model's turn in the mimir tab picks from. */
export const TURN_SETS = ['build', 'shape', 'edit', 'app', 'print'] as const
export type TurnSet = (typeof TURN_SETS)[number]

/** The tool that loads another set for the rest of a turn. Offered only where turns pick a set. */
export const TURN_SET_TOOL = 'pilot.tools'

/** Tools every turn sends: questions, lookups, notes and the project's contents. */
const EVERY_TURN: ReadonlySet<string> = new Set([TURN_SET_TOOL, 'pilot.ask', 'lookup.show', 'parts.lookup', 'kb.search', 'web.lookup', 'memory.recall', 'memory.remember', 'project.info'])

/**
 * Tools of EVERY_TURN a new part's turn leaves out, where a local model's context is fullest: saving a note never was a
 * step of building a part in the local or eval runs. Every other set sends them, and calling one never moves a turn to
 * another set.
 */
const NOT_ON_BUILD: ReadonlySet<string> = new Set(['memory.remember'])

/**
 * Building a new part: the sheet and plan, the solids, the common features, and reading the part back. These are the
 * steps the prompt names for a new part; the rest of the design tools are in shape and edit.
 */
const BUILD: ReadonlySet<string> = new Set(['pilot.sheet', 'pilot.sheet_bind', 'design.new', 'design.plan', 'design.check', 'design.undo', 'geom.extrude', 'geom.revolve', 'geom.loft', 'geom.sweep', 'geom.hole', 'geom.fillet', 'geom.chamfer', 'geom.shell', 'geom.boolean', 'geom.info', 'geom.edge_pick', 'geom.faces'])

/**
 * Shaping a part further: join, cut, pattern, split, mark and fix it, and measure it: sections, interference and its
 * print-in-place gaps. The fit check is here rather than in build, where a local model's new part turn has no room for
 * it: a print-in-place part loads it when design.check asks for it (calling it loads this set).
 */
const SHAPE: ReadonlySet<string> = new Set(['design.undo', 'geom.info', 'geom.measure', 'geom.fit_check', 'geom.interference', 'geom.push_pull', 'geom.mirror', 'geom.array', 'geom.split', 'geom.subtract', 'geom.emboss', 'geom.cut', 'geom.hollow', 'geom.repair', 'geom.build', 'geom.boolean'])

/**
 * Editing a part already built: open it, go through its steps and sketches, pick its faces and edges, project them
 * into a sketch (never a first part's step, so not in build), and step back and forth. Every other design tool is here too, so a design tool is never in no set.
 */
const EDIT: ReadonlySet<string> = new Set(['design.undo', 'design.redo', 'design.open', 'design.list', 'design.save', 'design.timeline', 'design.steps', 'design.edit_step', 'design.roll', 'design.sketch', 'design.sketch_svg', 'design.sketch_project', 'geom.info', 'geom.sketch_edit', 'geom.sketch_solve', 'geom.sketch_check', 'geom.face_pick', 'geom.edge_pick', 'geom.faces', 'geom.hole_edit'])

/**
 * The project's filaments: shaping a part carries them beside the rest of the project in app. Not in build, whose turn
 * fills a local model's context nearly to the brim; calling one loads its set.
 */
const FILAMENTS: ReadonlySet<string> = new Set(['project.add_filament', 'project.set_filament'])

/** Painting a design's parts in filaments (a waterline, a band): with the filaments, in shape and app. */
const PAINT: ReadonlySet<string> = new Set(['paint.preview', 'paint.apply', 'paint.regions'])

/**
 * Sending a sliced plate: which printer and spools, the printers' list and state, and the send. In app as well as
 * print, so slicing and sending a plate takes one set.
 */
const SEND: ReadonlySet<string> = new Set(['run.target', 'printer.list', 'printer.status', 'printer.queue'])

/** What each set's tool description says it holds. */
export const TURN_SET_WORDS: Record<TurnSet, string> = {
  build: 'start a new part: the dimension sheet, the plan, sketches extruded, revolved, lofted or swept into solids, holes, fillets, chamfers, shells, booleans, and reading the part back',
  shape: 'shape a part further: push and pull faces, mirror, pattern, split, subtract, emboss text, cut, hollow, repair, paint it in filaments, and measure it',
  edit: 'change a part already built: open it, its timeline and steps, its sketches, pick faces and edges, change its holes, undo and redo',
  app: 'slicing, settings and profiles, the project and plate, the knowledge base, the app commands, and sending a sliced plate to a printer',
  print: 'the printers: their state, history and cameras, sending, pausing and canceling prints, spools, fleets and schedules, setting printers up, and their commands',
}

/** The same sets in fewer words, for the local description of pilot.tools. */
const TURN_SET_SHORT: Record<TurnSet, string> = {
  build: 'a new part (dimension sheet, plan, sketches extruded, revolved, lofted or swept, holes, fillets, chamfers, shells, booleans, reading it back)',
  shape: 'push and pull faces, mirror, pattern, split, subtract, emboss text, cut, hollow, repair, paint, measure',
  edit: 'a built part (open it, timeline, steps, sketches, face and edge picks, undo, redo)',
  app: 'slicing, settings, profiles, project, plate, knowledge base, app commands, sending a sliced plate to a printer',
  print: 'printers (state, history, cameras, sending, pausing and canceling prints, spools, fleets, schedules, setup, commands)',
}

const isDesign = (t: GroupedTool): boolean => toolGroupOf(t) === 'design' && (t.name.startsWith('design.') || t.name.startsWith('geom.'))

/**
 * The sets a tool belongs to, or 'every' for the tools every turn sends (but NOT_ON_BUILD, which a build turn leaves
 * out) and whose call never moves a turn to another set: design tools by name, printer tools (by their
 * group, so a printer plugin's tools and each printer's commands count) in print, anything else in app.
 */
export function turnSetsOf(t: GroupedTool): ReadonlySet<TurnSet> | 'every' {
  if (EVERY_TURN.has(t.name)) return 'every'
  if (FILAMENTS.has(t.name) || PAINT.has(t.name)) return new Set<TurnSet>(['shape', 'app'])
  const sets = new Set<TurnSet>()
  if (BUILD.has(t.name)) sets.add('build')
  if (SHAPE.has(t.name)) sets.add('shape')
  if (EDIT.has(t.name)) sets.add('edit')
  if (sets.size) return sets
  if (SEND.has(t.name)) return new Set<TurnSet>(['app', 'print'])
  // a design tool none of the lists name (a new one) goes with editing, so it is still in a set
  if (isDesign(t)) return new Set<TurnSet>(['edit'])
  const group = toolGroupOf(t)
  return new Set<TurnSet>([group === 'printers' || group === 'watch' ? 'print' : 'app'])
}

/** Whether a turn on `set` sends `t`. */
export function inTurnSet(t: GroupedTool, set: TurnSet): boolean {
  const sets = turnSetsOf(t)
  if (sets === 'every') return set !== 'build' || !NOT_ON_BUILD.has(t.name)
  return sets.has(set)
}

/** `tools` a turn on `set` sends, in their own order. */
export function turnSetTools<T extends GroupedTool>(tools: readonly T[], set: TurnSet): T[] {
  return tools.filter((t) => inTurnSet(t, set))
}

/** Words that ask for slicing, settings, the plate and project, or knowledge. */
const APP_WORDS =
  /\b(slic\w*|settings?|profiles?|layer heights?|infill|supports?|brims?|rafts?|speeds?|temperatures?|temps?|nozzles?|filaments?|materials?|pla|petg|abs|asa|tpu|print (?:it|this|that|them)|orient\w*|arrange\w*|estimat\w*|calibrat\w*|plates?|projects?|export\w*|3mf|g-?code|theme|dark mode|light mode|string\w*|warp\w*|clog\w*|adhesion|troubleshoot\w*)\b/i

/** Words about the printers themselves: their state, prints going, spools, fleets. */
const PRINT_WORDS = /\b(printers?|printing|jobs?|spools?|ams|camera|pause\w*|resume\w*|cancel\w*|schedul\w*|fleets?|farm|overnight|queue\w*|progress|status|how(?:'s| is) (?:the|my) print)\b/i

/** Words that ask for a new part. */
const BUILD_WORDS = /\b(make|design|model|build|create|draw|cad|sketch|part|box|cube|cylinder|bracket|hook|lid|gear|knob|holder|mount|stand|clip|spacer|plate with|enclosure|case)\w*\b/i

/** Words that shape a part further. */
const SHAPE_WORDS = /\b(mirror\w*|array|pattern\w*|split\w*|subtract\w*|emboss\w*|engrav\w*|text on|(?:text|labels?) (?:on|onto|into)|hollow\w*|repair\w*|push|pull|measure\w*|cut (?:out|away|off|a|the|it|into)|cuts? (?:in|on|through|across|along)|cut-?outs?|cop(?:y|ies) of|combine|merge)\b/i

/** Words that change a part already built. */
const EDIT_WORDS = /\b(edit\w*|change|changing|resize\w*|bigger|smaller|wider|narrower|taller|shorter|thicker|thinner|longer|deeper|rename|undo|redo|step|steps|timeline|open the design|go back|move (?:the|it)|adjust\w*|instead)\b/i

const readsFile = (files: readonly Pick<PilotAttachment, 'type'>[]): boolean => files.some((f) => f.type.startsWith('image/') || f.type === 'application/pdf')

/** What the runtime knows about the chat a turn is in. */
export interface TurnChat {
  /**
   * Whether there is a design to shape: the host's plate holds a body with a history, or the chat started a design that
   * is still waiting for its first body, or, where the host cannot say, one of the chat's own tools made or opened one
   * (designMade).
   */
  design?: boolean
}

/**
 * The set a turn starts on, from the request and the chat: a picture or PDF to build from is a new part; words about
 * shaping or changing a part pick those sets; words about slicing, settings, the project or a print problem pick app,
 * and words about the printers alone pick print, unless the request also asks for a new part, which comes first ("a
 * hook, then slice it"). With no design there is nothing to shape, so a request with shaping words builds ("make it
 * hollow", "give me a box with my name engraved on the lid"). With a design, a request with words for a part and for
 * shaping one shapes when it opens on shaping a part it names ("mirror the bracket", "make it hollow", "make the lid
 * hollow"), puts the shaping on one ("engrave SX on the lid", "a pattern of four holes on it") and does not open on a
 * new part ("make a box with a slot in the lid"), or opens on a shaping with no part named ("make a circular pattern
 * of six holes", "make a cut-out for the USB port"). Anything else with words for a part builds ("make a hollow vase",
 * "now make another hollow vase", "a hollow box with a lid"): sending a local model the build and shape sets together
 * would not fit its context. A request with none of these words keeps `last`, the set the chat's previous turn ended
 * on, or starts a part when there is none.
 */
export function turnSet(message: string, files: readonly Pick<PilotAttachment, 'type'>[] = [], last?: TurnSet, chat: TurnChat = {}): TurnSet {
  if (readsFile(files)) return 'build'
  const print = PRINT_WORDS.test(message)
  const app = APP_WORDS.test(message) || print
  const build = BUILD_WORDS.test(message) || WANT_PART.test(message)
  // with no body on the plate there is nothing to shape: a request to shape one builds, whatever it names
  const design = chat.design === true
  const there = design && (SHAPE_START.test(message) || OWN_START.test(message) || (ON_A_PART.test(message) && !NEW_PART.test(message)) || SHAPING_OPEN.test(message))
  const newPart = build && !there
  if (SHAPE_WORDS.test(message) && !app) {
    if (!design) return 'build'
    if (!newPart) return 'shape'
  }
  if (EDIT_WORDS.test(message) && !app && (last === 'build' || last === 'shape' || last === 'edit')) return 'edit'
  // both: a request that opens on making a part, or makes it and then prints, builds first; else it is about the app
  if (build && (!app || BUILD_START.test(message) || THEN.test(message))) return 'build'
  // the printers alone pick print; with slicing or settings words too, app has the send tools as well
  if (print && !APP_WORDS.test(message)) return 'print'
  if (app) return 'app'
  return last ?? 'build'
}

/**
 * Whether a tool's successful result means the chat has a design to shape: design.new or design.open went through, or a
 * geometry step answered with a design that has a body (its id and at least one part). A geometry tool that touches no
 * design (a sketch solved on its own, a loose model, a calibration model), a list and a plan do not count.
 */
export function designMade(tool: string, output: unknown): boolean {
  if (tool === 'design.new' || tool === 'design.open') return true
  if (!tool.startsWith('geom.') || !output || typeof output !== 'object') return false
  const o = output as { design?: unknown; parts?: unknown }
  return typeof o.design === 'string' && Array.isArray(o.parts) && o.parts.length > 0
}

/** A request that goes on to a second thing after the first ("a hook, then slice it"). */
const THEN = /\b(then|and then|after that|afterwards)\b/i

/** What a request may open on before its verb: "ok, now", "next,", "can you please". */
const LEAD = String.raw`^\s*(?:(?:ok(?:ay)?|great|good|nice|cool|thanks|alright|now|next|also|and|then|so)[,.!:]?\s+)*(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?`
/** Wanting something: "I want", "I need", "I'd like you to make me". */
const WANTING = String.raw`i\s*(?:want|need|would like|['\u2019]?d like)\s+(?:you\s+to\s+(?:make|design|model|build|create|draw)\s+(?:me\s+)?)?`
/** Making something: the verb, or wanting it. */
const MAKING = String.raw`(?:(?:make|design|model|build|create|draw)\s+(?:me\s+|us\s+)?|${WANTING})?`
/** How many: an article, a count, "another" or "one more". */
const HOW_MANY = String.raw`(?:a|an|some|another|one more|two|three|four|five|six|\d+)\s+`
/** A word before the noun ("circular", "hole", "mirrored"), never one that starts a part of its own ("with", "and"). */
const MODIFIER = String.raw`(?!(?:with|and|for|that|which|to)\b)[\w-]+\s+`
/**
 * A shaping of a part, as made: a pattern, array, copy, image or version of or on something ("a circular pattern of
 * six holes", "a hole pattern on the lid", "a mirrored copy of it"), a cut, cut-out or split in or for something, and
 * an engraving, label or text on something.
 */
const SHAPING = String.raw`(?:(?:${MODIFIER}){0,2}(?:pattern|array|cop(?:y|ies)|image|version)s?\s+(?:of|on|in|along|around|across)\b|(?:${MODIFIER})?(?:cut[- ]?outs?|cuts?|splits?)\s+(?:in|on|into|through|from|for|of|along|across)\b|(?:${MODIFIER})?(?:engravings?|labels?|texts?|embossings?)\s+(?:of|on|in|into|onto|along|across)\b)`

/**
 * A request that opens on making a new part, however it leads in ("design a stand ...", "make me two clips", "now make
 * another hollow vase", "I want a hollow vase", or just "a hollow box ..."), not on a shaping of one ("make a pattern
 * of holes", "make a circular pattern of six holes", "make a mirrored copy of it", "make a cut-out for the USB port").
 */
const NEW_PART = new RegExp(`${LEAD}${MAKING}${HOW_MANY}(?!${SHAPING})`, 'i')

/** A request that opens on wanting a part ("I want a hollow vase", "I need two clips"), which asks for a part as making one does. */
const WANT_PART = new RegExp(`${LEAD}${WANTING}${HOW_MANY}(?!${SHAPING})`, 'i')

/**
 * Whether a request opens on asking for a part of its own, a new one or another ("now make me a second one", "make a
 * lid for it", "I need two clips"), and not on changing or shaping the one there ("make it rounder", "round off the
 * body", "make a pattern of holes on it").
 */
export function asksAnotherPart(message: string): boolean {
  return NEW_PART.test(message) || WANT_PART.test(message)
}

/** A request that opens on making a shaping of a part ("make a pattern of holes", "make a cut in the lid"). */
const SHAPING_OPEN = new RegExp(`${LEAD}${MAKING}${HOW_MANY}${SHAPING}`, 'i')

/** A request that opens on a shaping of a part it names ("mirror the bracket", "split it in half", "hollow out the base"). */
const SHAPE_START =
  /^\s*(?:please\s+)?(?:can you\s+|could you\s+)?(?:mirror|split|pattern|array|subtract|emboss|engrave|hollow|repair|measure|cut|combine|merge)\s+(?:out\s+)?(?:the|it|this|that|these|those|them|both|my)\b/i

/**
 * A request that opens on making a part that is there into something ("make it hollow", "make the lid split in half",
 * "make the side wall hollow"): a part named with "the" or "my" counts only when a shaping follows it, so "make the
 * case for my Raspberry Pi with a cut-out" and "make the hollow vase I described" are new parts.
 */
const OWN_START = new RegExp(String.raw`${LEAD}(?:make|turn|get)\s+(?:(?:it|this|that|them|these|those)\b|(?:the|my)\s+[\w-]+(?:\s+[\w-]+)?\s+(?:hollow|split|mirror|pattern|engrav|emboss|array|cut|symmetric)\w*\b)`, 'i')

/**
 * Shaping put on a part that is there: on, to, in or of "it", "this" or a part named with "the" ("engrave SX on the lid",
 * "add holes to the lid", "a pattern of four holes on it"), but not a place ("in the middle", "on the other side").
 */
const ON_A_PART =
  /\b(?:(?:on|onto|to|in|into|from|through|along|around|across|of)\s+(?:it|this|that|them|its\s+[\w-]+|the\s+(?!(?:middle|center|same|way|other|rest|inside|outside|left|right)\b)[\w-]+)|(?:on|onto|to|in|into)\s+my\s+[\w-]+)\b/i

/** A request that opens on making a part ("make a hook ...", "design me ..."), which builds first whatever follows. */
const BUILD_START = /^\s*(?:please\s+)?(?:can you\s+|could you\s+)?(?:make|design|model|build|create|draw)\b/i

/**
 * pilot.tools: loads another set for the rest of the turn, in place of the one it has. `pick` keeps the choice for the
 * runtime, which sends that set from the next step on.
 */
export function turnSetTool(pick: (sessionId: string, set: TurnSet) => void): PilotTool<never> {
  return defineTool({
    name: TURN_SET_TOOL,
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `Load another set of tools when the ones you have do not cover the next step. You get its tools from your next step on, in place of the current set. ${TURN_SETS.map((s) => `${s}: ${TURN_SET_WORDS[s]}.`).join(' ')}`,
    localDescription: `Load another tool set (set) when yours does not cover the next step; it replaces yours from your next step on. ${TURN_SETS.map((s) => `${s}: ${TURN_SET_SHORT[s]}.`).join(' ')}`,
    input: z.object({ set: z.enum(TURN_SETS) }),
    args: (i) => i.set,
    async run(i, ctx) {
      pick(ctx.sessionId, i.set)
      return { summary: `Loaded the ${i.set} tools`, output: { loaded: i.set } }
    },
  }) as PilotTool<never>
}
