// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which tools one turn sends a local model in the mimir tab. A local model's whole context is MIMIR_CONTEXT tokens
// (context.ts), and the tab's tools alone measure well over that, so the system prompt would be cut off. Each turn
// sends the tools every turn needs and one set picked for it: building a new part, shaping one, editing one, the app
// (slicing, settings, the project, the knowledge base and the app's commands), or the printers. The set is
// read from the request's words; a request with no such words keeps the chat's last set. A model that needs a tool of
// another set loads it with pilot.tools, and calling a tool of another set loads that set for the next step, so a
// turn never gets stuck without a tool. A cloud model is not affected: every turn sends every tool, as before.
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
 * Building a new part: the sheet and plan, the solids, the common features, and reading the part back. These are the
 * steps the prompt names for a new part; the rest of the design tools are in shape and edit.
 */
const BUILD: ReadonlySet<string> = new Set(['pilot.sheet', 'pilot.sheet_bind', 'design.new', 'design.plan', 'design.check', 'design.undo', 'geom.extrude', 'geom.revolve', 'geom.hole', 'geom.fillet', 'geom.chamfer', 'geom.shell', 'geom.boolean', 'geom.info'])

/** Shaping a part further: join, cut, pattern, split, mark and fix it, and measure it. */
const SHAPE: ReadonlySet<string> = new Set(['design.undo', 'geom.info', 'geom.measure', 'geom.push_pull', 'geom.mirror', 'geom.array', 'geom.split', 'geom.subtract', 'geom.emboss', 'geom.cut', 'geom.hollow', 'geom.repair', 'geom.build', 'geom.boolean'])

/**
 * Editing a part already built: open it, go through its steps and sketches, pick its faces and edges, and step back
 * and forth. Every other design tool is here too, so a design tool is never in no set.
 */
const EDIT: ReadonlySet<string> = new Set(['design.undo', 'design.redo', 'design.open', 'design.list', 'design.save', 'design.timeline', 'design.steps', 'design.edit_step', 'design.roll', 'design.sketch', 'geom.info', 'geom.sketch_edit', 'geom.sketch_solve', 'geom.sketch_check', 'geom.face_pick', 'geom.edge_pick', 'geom.faces'])

/**
 * Sending a sliced plate: which printer and spools, the printers' list and state, and the send. In app as well as
 * print, so slicing and sending a plate takes one set.
 */
const SEND: ReadonlySet<string> = new Set(['run.target', 'printer.list', 'printer.status', 'printer.queue'])

/** What each set's tool description says it holds. */
export const TURN_SET_WORDS: Record<TurnSet, string> = {
  build: 'start a new part: the dimension sheet, the plan, sketches extruded or revolved into solids, holes, fillets, chamfers, shells, booleans, and reading the part back',
  shape: 'shape a part further: push and pull faces, mirror, pattern, split, subtract, emboss text, cut, hollow, repair, and measure it',
  edit: 'change a part already built: open it, its timeline and steps, its sketches, pick faces and edges, undo and redo',
  app: 'slicing, settings and profiles, the project and plate, the knowledge base, the app commands, and sending a sliced plate to a printer',
  print: 'the printers: their state, history and cameras, sending, pausing and canceling prints, spools, fleets and schedules, setting printers up, and their commands',
}

const isDesign = (t: GroupedTool): boolean => toolGroupOf(t) === 'design' && (t.name.startsWith('design.') || t.name.startsWith('geom.'))

/**
 * The sets a tool belongs to, or 'every' for the tools every turn sends: design tools by name, printer tools (by their
 * group, so a printer plugin's tools and each printer's commands count) in print, anything else in app.
 */
export function turnSetsOf(t: GroupedTool): ReadonlySet<TurnSet> | 'every' {
  if (EVERY_TURN.has(t.name)) return 'every'
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
  return sets === 'every' || sets.has(set)
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
const SHAPE_WORDS = /\b(mirror\w*|array|pattern\w*|split\w*|subtract\w*|emboss\w*|engrav\w*|text on|hollow\w*|repair\w*|push|pull|measure\w*|cut (?:out|away|off|a|the|it|into)|combine|merge)\b/i

/** Words that change a part already built. */
const EDIT_WORDS = /\b(edit\w*|change|changing|resize\w*|bigger|smaller|wider|narrower|taller|shorter|thicker|thinner|longer|deeper|rename|undo|redo|step|steps|timeline|open the design|go back|move (?:the|it)|adjust\w*|instead)\b/i

const readsFile = (files: readonly Pick<PilotAttachment, 'type'>[]): boolean => files.some((f) => f.type.startsWith('image/') || f.type === 'application/pdf')

/**
 * The set a turn starts on, from the request: a picture or PDF to build from is a new part; words about shaping or
 * changing a part pick those sets; words about slicing, settings, the project or a print problem pick app, and words
 * about the printers alone pick print, unless the request also asks for a new part, which comes first ("a hook, then
 * slice it"). A request with none of these words keeps `last`, the set the chat's previous turn ended on, or starts a
 * part when there is none.
 */
export function turnSet(message: string, files: readonly Pick<PilotAttachment, 'type'>[] = [], last?: TurnSet): TurnSet {
  if (readsFile(files)) return 'build'
  const print = PRINT_WORDS.test(message)
  const app = APP_WORDS.test(message) || print
  const build = BUILD_WORDS.test(message)
  if (SHAPE_WORDS.test(message) && !app) return 'shape'
  if (EDIT_WORDS.test(message) && !app && (last === 'build' || last === 'shape' || last === 'edit')) return 'edit'
  // both: a request that opens on making a part, or makes it and then prints, builds first; else it is about the app
  if (build && (!app || BUILD_START.test(message) || THEN.test(message))) return 'build'
  // the printers alone pick print; with slicing or settings words too, app has the send tools as well
  if (print && !APP_WORDS.test(message)) return 'print'
  if (app) return 'app'
  return last ?? 'build'
}

/** A request that goes on to a second thing after the first ("a hook, then slice it"). */
const THEN = /\b(then|and then|after that|afterwards)\b/i

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
    input: z.object({ set: z.enum(TURN_SETS) }),
    args: (i) => i.set,
    async run(i, ctx) {
      pick(ctx.sessionId, i.set)
      return { summary: `Loaded the ${i.set} tools`, output: { loaded: i.set } }
    },
  }) as PilotTool<never>
}
