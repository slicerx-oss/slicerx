// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Engine refusals in plain words. A failed step's row shows the person what happened in a sentence they can read, with
// what to try; the model still gets the engine's own text, with how to try again, so it can retry without quoting the
// engine. The engine's text stays in the row's details. Refusals are grouped by what the person can do about them, not
// one entry per engine message, and an engine refusal none of them knows gets a plain line of its own.
import { isGeomStuck } from '@slicerx/contracts/geom-limits'

interface Refusal {
  test: RegExp
  /** The step's row, for the person. */
  shown: string
  /** Added to the model's tool result: how to go on. */
  hint: string
}

const NEVER_QUOTE = 'Try again once, and tell the person in plain words if it still fails; never quote the engine text or its setting names.'

const REFUSALS: readonly Refusal[] = [
  {
    // boolean.rs storage_mesh and stored(): a cut, join or merged array whose result only holds at full precision,
    // from faces that line up
    test: /unsafe at mesh storage precision/i,
    shown: 'That step left slivers too thin to keep, so it was not made. Overlapping the shapes a little more usually fixes it.',
    hint: `The cut or join left faces that line up or slivers. For a cut, extend the cutting shape about 0.05 mm past the faces it meets; for a join, overlap the bodies about 0.05 mm rather than letting faces just touch. ${NEVER_QUOTE}`,
  },
  {
    // boolean.rs too_long and sx-geom's deadline (mcp geom.ts). The hosts' own time limit already says it plainly, with
    // the step's name (geom-limits.ts geomStuckMessage), so it is left as it is.
    test: /taking too long to finish|exceeded its execution deadline/i,
    shown: 'That step took too long, so it was stopped. Try fewer copies or a simpler shape.',
    hint: `The step ran out of time. The same step would stop the same way: build a smaller version (fewer copies, join them in smaller groups, a simpler profile or a coarser mesh). ${NEVER_QUOTE}`,
  },
  {
    // edge.rs (fillet, chamfer), sketch_loft.rs, sketch_sweep.rs, thicken.rs, json_cad.rs: a shape whose sides would
    // cross or fold over
    test: /runs? into itself|touch or cross|crosses or runs back over itself|sides would cross|bend too sharply|bends too tightly|folds? (over|onto) itself|turns back on itself|the other way around where the ring closes/i,
    shown: 'That shape would fold into itself, so it was not made. Try a gentler curve, more room between its parts, or a smaller size.',
    hint: `The shape crosses itself: a sweep bends tighter than its profile, loft profiles touch, or a shell is thicker than the gaps in the surface. Space the parts apart, widen the bend or make the profile or shell smaller. ${NEVER_QUOTE}`,
  },
  {
    // edge.rs fit_error and too-short edges, shell.rs, push.rs: a size the faces or body cannot hold
    test: /\d mm does not fit|too short for this size|not watertight; try a smaller size|too thick for this body|not watertight; try another wall|face is too small to move/i,
    shown: 'That size is too big for this part, so the step was not made. Try a smaller size.',
    hint: `The size does not fit the part: a fillet, chamfer, wall or move is bigger than the faces or body it meets. When the text gives the most that fits, use a bit less than that; otherwise try about half. ${NEVER_QUOTE}`,
  },
  {
    // edge.rs: a corner where three or more rounded edges meet
    test: /joins (more than )?three fillets/i,
    shown: 'Too many rounded edges meet at one corner, so the step was not made. Try rounding fewer of its edges, or a chamfer.',
    hint: `Too many fillets meet at one corner. Leave one or more of that corner's edges out, or make one of them a chamfer. ${NEVER_QUOTE}`,
  },
  {
    // edge.rs, shell.rs, cad-history replay.ts: the face or edge the step was given moved or is gone
    test: /pick (it|the face|the edge) again|repair the reference|missing face reference|is not there any more|not on a face of the body|pick near the edge|missing face;|ambiguous face;|the face this step moved is gone/i,
    shown: 'That step lost track of the face or edge it works on, so it was not made. Picking it again on the part fixes it.',
    hint: `The face or edge the step names moved or is gone. Pick it again on the part as it is now (geom.face_pick or geom.edge_pick) and send the step with the new pick. ${NEVER_QUOTE}`,
  },
  {
    // push.rs, shell.rs, cut.rs, hollow.rs, cad-history replay.ts: a step that would leave nothing, or misses the part
    test: /removes the whole body|leaves no body|nothing is left of the part|no longer reaches the part|no longer crosses the part|the mesh is empty|no surface to thicken/i,
    shown: 'That step would cut away the whole part or miss it, so it was not made. Check where it sits on the part, or make it smaller.',
    hint: `The step would leave no part, or no longer touches the part. Check its placement against the part's size and make the cut or move smaller. ${NEVER_QUOTE}`,
  },
  {
    // array.rs, sketch_sweep.rs, sketch_loft.rs, hollow.rs, split.rs, mesh.rs: more copies, points or cells than the
    // engine builds in one step
    test: /at most \d+ copies|would have more than|more than \d+ points|too many triangles|grid would have [0-9.]+ cells|more than \d+ parts would be needed|a loft takes at most/i,
    shown: 'That step asks for more detail than can be built at once, so it was not made. Try fewer copies or a simpler shape.',
    hint: `The step is over one of the engine's size limits (copies, points, cells or parts). Use fewer copies, fewer or simpler profiles, a shorter path or a larger voxel. ${NEVER_QUOTE}`,
  },
]

/** Any engine refusal none of the groups above knows. */
const FALLBACK: Omit<Refusal, 'test'> = {
  shown: 'That step could not be made, so the part is unchanged. Try asking for it another way, or with simpler sizes.',
  hint: `The engine refused this step. Read why, then change the step or build it another way. ${NEVER_QUOTE}`,
}

/** Tools whose failures come from the geometry engine: the design and modeling tools and the app's own model steps. */
const MODELING = /^(geom|design|parts)\.|^app\.(model_|paint|sketch)/

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
 * The plain line, retry hint and the engine's own text for a failed step's text, or undefined when it is no engine
 * refusal. `tool` is the tool that failed: text from a tool that does not model is left alone unless only the engine
 * could have written it, so a printer's or the slicer's own sentences keep their words.
 */
export function plainEngine(summary: string, tool?: string): { shown: string; hint: string; raw: string } | undefined {
  // the hosts' time limit says it plainly already, naming the step, even passed on inside another sentence
  if (isGeomStuck(summary)) return undefined
  const modeling = tool === undefined || MODELING.test(tool)
  if (!modeling && !ENGINE_ONLY.test(summary)) return undefined
  const r = REFUSALS.find((x) => x.test.test(summary)) ?? (engineShaped(summary) || ENGINE_ONLY.test(summary) ? FALLBACK : undefined)
  return r ? { shown: r.shown, hint: r.hint, raw: summary } : undefined
}
