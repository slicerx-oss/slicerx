// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Engine refusals in plain words. A failed step's row shows the person what happened in a sentence they can read, with
// what to try; the model still gets the engine's own text, with how to try again, so it can retry without quoting the
// engine. The engine's text stays in the row's details. Refusals are grouped by what the person can do about them, not
// one entry per engine message, and an engine refusal none of them knows gets a plain line of its own.
import { isGeomStuck } from '@slicerx/contracts/geom-limits'
import { ASSISTANT_NAME } from './name'

interface Refusal {
  test: RegExp
  /** The row's title: what happened, in a few words. */
  title: string
  /** The step's row, for the person; {name} is the assistant's name as it is when the row is made. */
  shown: string
  /** Added to the model's tool result: how to go on. */
  hint: string
}

const NEVER_QUOTE = 'Try again once, and tell the person in plain words if it still fails; never quote the engine text or its setting names.'

const REFUSALS: readonly Refusal[] = [
  {
    // mcp cad.ts and modeling-tools.ts: a step sent in a way its tool does not take (a target or part that does not
    // fit the design, a sweep profile away from its path, the hole tool asked for a new hole, a subtract shape a design
    // step does not take). The person did nothing wrong, so the line gives them nothing to do
    test: /leave target out|give part, one of|but part is \d+|; give one of them$|^part: the design has \d+ parts?$|its loop sits [0-9.]+ mm from where the path starts|This tool changes a hole that is already there|a design's subtract step takes boxes and cylinders/,
    title: 'Step sent wrong',
    shown: '{name} sent that step the wrong way, so it was not made. The part is unchanged.',
    hint: `The step was sent in a way this tool does not take; the text says what to change (for a join or cut on a design, leave target out and give part). ${NEVER_QUOTE}`,
  },
  {
    // cad-history replay.ts: an earlier step removed or merged the part this one works on
    test: /The part this step works on is gone|A part this step combines is gone/,
    title: 'Part is gone',
    shown: 'The part that step works on is no longer there, so the step was not made.',
    hint: `An earlier step removed or merged the part this step works on. Check the design's parts as they are now and send the step for one that is there. ${NEVER_QUOTE}`,
  },
  {
    // json_cad.rs loft_stored: a loft whose result only holds at full precision. A loft has no cut or placement to
    // change, so it gets its own advice
    test: /loft: the result is unsafe at mesh storage precision|change the loft's profiles or the spacing between them/i,
    title: 'Loft not made',
    shown: "That loft left slivers too thin to keep, so it was not made. Try to change the loft's profiles or the spacing between them.",
    hint: `The loft's surface came out with slivers or faces that line up, so change the loft's profiles or the spacing between them: profiles a little further apart, or ones that differ less from one to the next. ${NEVER_QUOTE}`,
  },
  {
    // boolean.rs storage_mesh and stored(): a cut, join or merged array whose result only holds at full precision,
    // from faces that line up
    test: /unsafe at mesh storage precision/i,
    title: 'Slivers too thin',
    shown: 'That step left slivers too thin to keep, so it was not made. Overlapping the shapes a little more usually fixes it.',
    hint: `The cut or join left faces that line up or slivers. For a cut, extend the cutting shape about 0.05 mm past the faces it meets; for a join, overlap the bodies about 0.05 mm rather than letting faces just touch. ${NEVER_QUOTE}`,
  },
  {
    // boolean.rs too_long and sx-geom's deadline (mcp geom.ts). The hosts' own time limit already says it plainly, with
    // the step's name (geom-limits.ts geomStuckMessage), so it is left as it is.
    test: /taking too long to finish|exceeded its execution deadline/i,
    title: 'Took too long',
    shown: 'That step took too long, so it was stopped. Try fewer copies or a simpler shape.',
    hint: `The step ran out of time. The same step would stop the same way: build a smaller version (fewer copies, join them in smaller groups, a simpler profile or a coarser mesh). ${NEVER_QUOTE}`,
  },
  {
    // edge.rs (fillet, chamfer), sketch_loft.rs, sketch_sweep.rs, thicken.rs, json_cad.rs: a shape whose sides would
    // cross or fold over
    test: /runs? into itself|touch or cross|crosses or runs back over itself|sides would cross|bend too sharply|bends too tightly|folds? (over|onto) itself|turns back on itself|the other way around where the ring closes/i,
    title: 'Shape would fold',
    shown: 'That shape would fold into itself, so it was not made. Try a gentler curve, more room between its parts, or a smaller size.',
    hint: `The shape crosses itself: a sweep bends tighter than its profile, loft profiles touch, or a shell is thicker than the gaps in the surface. Space the parts apart, widen the bend or make the profile or shell smaller. ${NEVER_QUOTE}`,
  },
  {
    // edge.rs fit_error and too-short edges, shell.rs, push.rs: a size the faces or body cannot hold
    test: /\d mm does not fit|too short for this size|not watertight; try a smaller size|too thick for this body|not watertight; try another wall|face is too small to move/i,
    title: 'Size too big',
    shown: 'That size is too big for this part, so the step was not made. Try a smaller size.',
    hint: `The size does not fit the part: a fillet, chamfer, wall or move is bigger than the faces or body it meets. When the text gives the most that fits, use a bit less than that; otherwise try about half. ${NEVER_QUOTE}`,
  },
  {
    // edge.rs: an edge on a round taken from the curved side, or edges along a round taken from different faces
    test: /picked face is curved\. Pick the edge from the flat face|meet along a round; pick both from the flat face they share/i,
    title: 'Picked on a curve',
    shown: 'Fillet and chamfer take an edge from the flat face beside it, so the step was not made. Picking the edges again from that flat face fixes it.',
    hint: `The edges were picked from a curved face, or from different faces where they meet along a round. Pick them again with geom.edge_pick on the flat face they share and send its loopRef or chainRef. ${NEVER_QUOTE}`,
  },
  {
    // edge.rs: the same point of a round named by more than two picked edges
    test: /meet at one point along a round; pick each edge once/i,
    title: 'Edge picked twice',
    shown: 'Some edges were picked more than once where they meet along a curve, so the step was not made. Picking each edge once fixes it.',
    hint: `The edges list repeats an edge along a round. Send each edge once, or send the edge pick's loopRef or chainRef, which names each once. ${NEVER_QUOTE}`,
  },
  {
    // edge.rs: an edge the round tool cannot follow: both faces curved, an angle that changes along a round, or an
    // edge that ends square or at a slant against a curved face
    test: /both faces along this edge are curved|angle between the faces changes along the round|ends at a curved face it does not run into smoothly/i,
    title: 'Edge not rounded',
    shown: 'Fillet and chamfer cannot follow that edge where it meets a curved face, so the step was not made. Try other edges, or round the corner in the sketch before it is extruded.',
    hint: `This edge runs into or between curved faces in a way fillet and chamfer do not follow yet. Leave it out, or round that corner in the sketch before extruding it. ${NEVER_QUOTE}`,
  },
  {
    // edge.rs: a corner where three or more rounded edges meet
    test: /joins (more than )?three fillets/i,
    title: 'Too many fillets',
    shown: 'Too many rounded edges meet at one corner, so the step was not made. Try rounding fewer of its edges, or a chamfer.',
    hint: `Too many fillets meet at one corner. Leave one or more of that corner's edges out, or make one of them a chamfer. ${NEVER_QUOTE}`,
  },
  {
    // edge.rs, shell.rs, cad-history replay.ts: the face or edge the step was given moved or is gone
    test: /pick (it|the face|the edge) again|repair the reference|missing face reference|is not there any more|not on a face of the body|pick near the edge|missing face;|ambiguous face;|the face this step moved is gone/i,
    title: 'Face or edge lost',
    shown: 'That step lost track of the face or edge it works on, so it was not made. Picking it again on the part fixes it.',
    hint: `The face or edge the step names moved or is gone. Pick it again on the part as it is now (geom.face_pick or geom.edge_pick) and send the step with the new pick. ${NEVER_QUOTE}`,
  },
  {
    // push.rs, shell.rs, cut.rs, hollow.rs: a step that would leave nothing of the part. A join or cut that misses
    // the part already says why in plain words (MISSED)
    test: /removes the whole body|leaves no body|nothing is left of the part|the mesh is empty|no surface to thicken/i,
    title: 'Would remove the part',
    shown: 'That step would cut away the whole part, so it was not made. Check where it sits on the part, or make it smaller.',
    hint: `The step would leave no part. Check its placement against the part's size and make the cut or move smaller. ${NEVER_QUOTE}`,
  },
  {
    // array.rs, sketch_sweep.rs, sketch_loft.rs, hollow.rs, split.rs, mesh.rs: more copies, points or cells than the
    // engine builds in one step
    test: /at most \d+ copies|would have more than|more than \d+ points|too many triangles|grid would have [0-9.]+ cells|more than \d+ parts would be needed|a loft takes at most/i,
    title: 'Too much detail',
    shown: 'That step asks for more detail than can be built at once, so it was not made. Try fewer copies or a simpler shape.',
    hint: `The step is over one of the engine's size limits (copies, points, cells or parts). Use fewer copies, fewer or simpler profiles, a shorter path or a larger voxel. ${NEVER_QUOTE}`,
  },
]

/** Any engine refusal none of the groups above knows. */
const FALLBACK: Omit<Refusal, 'test'> = {
  title: 'Step not made',
  shown: 'That step could not be made, so the part is unchanged. Try asking for it another way.',
  hint: `The engine refused this step. Read why, then change the step or build it another way. ${NEVER_QUOTE}`,
}

/** Tools whose failures come from the geometry engine: the design and modeling tools and the app's own model steps. */
const MODELING = /^(geom|design|parts)\.|^app\.(model_|paint|sketch)/

/**
 * A join or cut that misses the part, as the hosts say it (cad-history missSentence, the app's cad-ops): how far short
 * it stops, inside the part, only touching it, part of it floating off, or no longer reaching it.
 */
const MISSED = /The shape (stops [0-9.]+ mm short of|is already inside|only touches|no longer reaches|does not reach) the (part|body)|Part of the shape would float off the (part|body)/

/** Text only the engine or its hosts write, whatever tool passed it on. */
const ENGINE_ONLY = /sx-geom|unsafe at mesh storage precision|taking too long to finish/i

/**
 * Whether a modeling tool's failure is in the engine's words rather than a sentence written for the person: the
 * engine's "op: why" form (packages/geom/src/error.rs), an internal setting key (wallMm), mesh terms, or a host's
 * wrapping of an engine reply.
 */
function engineShaped(text: string): boolean {
  if (/(?:^|: )[a-z][A-Za-z0-9_.]*: \S/.test(text)) return true
  if (/\b[a-z]+[A-Z][A-Za-z0-9]*\b/.test(text)) return true
  return /unknown operation|watertight|manifold|topology|triangles?\b|non-finite|base64|\bbrep\b|exact (operation|replay)|step \d+ broke:|did not go through:|exited with code/i.test(text)
}

/**
 * An edit of a step that the design kept although a step no longer builds, as design.edit_step says it ("Edited step
 * 6, ...: moved by [11, 0, 3.2] mm; step 6 broke: The shape stops 3.2 mm short of the part."). The broken step's
 * reason is carried when it is already plain (a join or cut that misses the part, the time limit); a reason one of the
 * groups knows keeps that group's cause and what to try; otherwise the line says only that the step no longer builds.
 */
const KEPT_EDIT = /^Edited step \d+, .*; step (\d+) broke: (.*)$/s

/** The reason group for a step sent in a way its tool does not take: input shape, no cause the person can act on. */
const SENT_WRONG = 'Step sent wrong'

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/**
 * A group's line as a kept edit's cause: its first sentence up to ", so ..." (what happened, without "it was not
 * made"), then the rest of the line, what to try, or `again` when the group gives nothing to try.
 */
function causeOf(shown: string, again: string): string | undefined {
  const end = shown.indexOf('. ')
  const first = end < 0 ? shown.replace(/\.$/, '') : shown.slice(0, end)
  const so = first.indexOf(', so ')
  if (so < 0 || first.includes('{name}')) return undefined
  const rest = end < 0 ? '' : shown.slice(end + 2).trim()
  return `${lowerFirst(first.slice(0, so))}. ${rest || again}`
}

function keptEdit(summary: string): { title: string; shown: string; hint: string; raw: string } | undefined {
  const m = KEPT_EDIT.exec(summary.trim())
  if (!m) return undefined
  const [, step, why] = m as unknown as [string, string, string]
  const reason = why.trim().replace(/[.\s]+$/, '')
  const again = 'Edit it again, or edit it back.'
  let shown = `The edit was made, but step ${step} no longer builds. ${again}`
  if (reason && (MISSED.test(reason) || isGeomStuck(reason))) shown = `The edit was made, but step ${step} no longer builds: ${lowerFirst(reason)}. ${again}`
  else {
    // the reason's own group, as plainEngine would pick it for a refused step
    const group = REFUSALS.find((x) => x.test.test(reason))
    const cause = group && group.title !== SENT_WRONG ? causeOf(group.shown, again) : undefined
    if (cause) shown = `The edit was made, but step ${step} no longer builds: ${cause}`
  }
  return {
    title: 'Edit kept, a step broke',
    shown,
    hint: `The edit is kept in the design, with step ${step} broken. Fix that step or edit this one again from where it is now; it was not refused, so do not send the opposite change to undo it. ${NEVER_QUOTE}`,
    raw: summary,
  }
}

/**
 * The plain line, retry hint and the engine's own text for a failed step's text, or undefined when it is no engine
 * refusal. `tool` is the tool that failed: text from a tool that does not model is left alone unless only the engine
 * could have written it, so a printer's or the slicer's own sentences keep their words.
 */
export function plainEngine(summary: string, tool?: string): { title: string; shown: string; hint: string; raw: string } | undefined {
  // an edit the design kept with a step broken is no refusal, whatever the broken step's reason says, so it is read
  // before the reason groups and never shown in their words
  const kept = keptEdit(summary)
  if (kept) return kept
  // the hosts' time limit says it plainly already, naming the step, even passed on inside another sentence
  if (isGeomStuck(summary)) return undefined
  // so does a join or cut that misses the part, with how far short it stops
  if (MISSED.test(summary)) return undefined
  const modeling = tool === undefined || MODELING.test(tool)
  if (!modeling && !ENGINE_ONLY.test(summary)) return undefined
  const r = REFUSALS.find((x) => x.test.test(summary)) ?? (engineShaped(summary) || ENGINE_ONLY.test(summary) ? FALLBACK : undefined)
  return r ? { title: r.title, shown: r.shown.replace('{name}', ASSISTANT_NAME), hint: r.hint, raw: summary } : undefined
}
