// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A design host: where designs live and how a step lands on one. The MCP server keeps designs in memory and writes
// files; the app keeps them as plate objects, so a step made through the host is the same history step a person's
// edit makes. The modeling tools take a host and never know which one they run on.
import type { SketchItem } from './design'
import type { ProjectMode, ProjectSource } from './project'
import type { History, HistoryMesh, Mat4, ReplayResult, Step, StepParams, StepStatus } from './model'
import { replayHistory } from './replay'
import type { FaceFrame, SketchConstraint, SketchLoop } from './types'

export interface Design {
  id: string
  name: string
  history: History
  /**
   * The design's own frame: every point a client gives and gets is in it. It is the object's transform on the plate
   * moved back by the moves a host made to land it (`placed`), so a step given in the frame the design was built in
   * still meets its body after a landing (design-frame.ts).
   */
  transform: Mat4
  /** How far the host's landings moved the object on the plate, mm in X and Y; absent when none did. */
  placed?: [number, number]
  /** The parts after the last replay, in the object's own frame. */
  parts: HistoryMesh[]
  status: StepStatus[]
  /** The step that made each face, by face key. */
  madeBy: Record<number, string>
  /** On a design with exact solids: the parts that are meshes, by index (ReplayResult.meshParts). */
  meshParts?: number[]
  /** Steps undone, last undone last; a new step clears them. */
  redo: Step[]
  /** Set only on the call that landed the part: its first body built off the bed, or an edit that left it off (Landed). */
  landed?: Landed
}

/**
 * A first body built off the bed: moved by (dxMm, dyMm) onto it as a whole, its coordinates staying the design's own;
 * or offBed when no spot on the bed holds it, so it stays where it was built. Off the bed counts what prints around the
 * part (brim, skirt) and the excluded areas. `edit` marks a part an edit left off the bed, landed again the same way;
 * `locked` one that stayed, and `parked` one that was off the bed before the edit and stays there. `room` names the
 * other designs a host moved over, each as a whole, so a new body had room on the bed.
 */
export type Landed = { dxMm: number; dyMm: number; edit?: true; room?: RoomMove[] } | { offBed: true; edit?: true; locked?: true; parked?: true }

/** Another design moved over on the plate, as a whole, to make room for a new body. */
export interface RoomMove {
  design: string
  name: string
  dxMm: number
  dyMm: number
}

export interface DesignCommit {
  step: Step
  revision: string
  /** Detached state captured at commit, before another operation can resume. */
  design: Design
}

/** How a step is added: the timeline sketch it draws on, the body revision it was picked on, and the planned feature it builds. */
export interface AddOptions {
  sketch?: string
  expectedRevision?: string
  feature?: string
  /** The group of the call that adds this step with others (Step.group), so they undo as one. */
  group?: string
}

export interface DesignHost {
  /** Opaque body revision for scoped topology reads; absent on legacy hosts. */
  revision?(id: string): string
  /** The design by id; throws a not-found error the tools pass on. */
  get(id: string): Design
  list(): Design[]
  /** A new design: empty (its first step makes the body) or from parts, with a history to replay when given. */
  create(name: string, base: HistoryMesh[], history?: History, transform?: Mat4, options?: { exact?: boolean }): Promise<Design>
  /**
   * Adds a step on part `part` (-1 for every part) and keeps it only when it goes through; else throws its reason.
   * `feature` records the planned feature the step builds on it.
   */
  add(d: Design, part: number, params: StepParams, label?: string, opts?: AddOptions): Promise<Step>
  /** Scoped edits require an atomic receipt rather than a later read of the host. */
  addWithReceipt?(d: Design, part: number, params: StepParams, label?: string, opts?: AddOptions): Promise<DesignCommit>
  /** Replays the design as `d.history` says, after a tool edited, removed or put back steps. */
  replay(d: Design, opts?: { expectedRevision?: string }): Promise<void>
  /**
   * Replays a history on the host's engine without keeping it (a step looked at as it was, a move tried out), as the
   * host replays its designs: on a served engine, with its bodies held there. Absent: replayed on `call` (replayOn).
   */
  replayed?(history: History): Promise<ReplayResult>
  /** The geometry engine the host replays on, for the picks and reads a tool makes on a design (face.pick, edge.pick). */
  call(op: string, request: unknown): Promise<unknown>
  /**
   * A finished sketch of the design timeline by id; only a host with a timeline (the app) has them. Its plane is where
   * the sketch stands now (design-frame.ts frameNow): given `design`, in that design's frame; without, in the plate's.
   */
  sketch?(id: string, design?: string): SketchItem
  /**
   * Puts a finished sketch in the design timeline at its marker. No frame is the bed. Given `design`, the frame is in
   * that design's frame, and the sketch is stored in the plate's.
   */
  addSketch?(s: { frame?: FaceFrame; loops: SketchLoop[]; constraints?: SketchConstraint[] }, design?: string): SketchItem
  /** The bed's size, mm, for placing on the bed; only a host with a printer (the app) knows it. */
  bed?(): { widthMm: number; depthMm: number }
  /** Solves loops with their constraints as the sketch tool does: the loops move to meet them, and a dimension that would over-define the sketch turns driven. */
  settleSketch?(s: { loops: SketchLoop[]; constraints: SketchConstraint[] }): Promise<{ loops: SketchLoop[]; constraints: SketchConstraint[]; status: 'ok' | 'redundant' | 'conflict' | 'failed'; dof: number }>
  /** Projects model geometry into a finished sketch (project.ts); the bodies drawn on it replay. Throws why the source gives no curves. */
  project?(sketch: string, source: ProjectSource, mode: ProjectMode): Promise<{ sketch: SketchItem; projection: string; replayed: number }>
  /** Switches a projection between reference and real, or takes it out with its curves; the bodies drawn on the sketch replay. */
  changeProjection?(sketch: string, projection: string, change: { mode: ProjectMode } | { remove: true }): Promise<{ sketch: SketchItem; replayed: number }>
}

const nameKey = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * The one design named `name` (case and spacing aside), for a call that gave a design's name where its id goes, or
 * undefined when no design or more than one has that name.
 */
export function designNamed<D extends Pick<Design, 'id' | 'name'>>(designs: readonly D[], name: string): D | undefined {
  const key = nameKey(name)
  const hits = designs.filter((d) => nameKey(d.name) === key)
  return hits.length === 1 ? hits[0] : undefined
}

/**
 * The refusal for a design that is not there: the ids of the designs that are (up to five, each with its name), so the
 * next call can give one, or how to start one when there are none. A name that several designs share is refused with
 * their ids, so it is not read as missing. `start` and `list` are the tools' names.
 */
export function noDesignMessage(given: string, designs: readonly Pick<Design, 'id' | 'name'>[], tools: { start: string; list: string }): string {
  if (!designs.length) return `design: no design ${given}; there are no designs yet, so start one with ${tools.start} and use the id it returns`
  const key = nameKey(given)
  const same = designs.filter((d) => nameKey(d.name) === key)
  if (same.length > 1) return `design: ${same.length} designs are named ${given}; give one of these ids: ${same.map((d) => `${d.id} (${d.name})`).join(', ')}`
  const ids = designs.slice(-5).map((d) => `${d.id} (${d.name})`).join(', ')
  return `design: no design ${given}; give a design id, such as ${ids}${designs.length > 5 ? `; ${tools.list} lists them all` : ''}`
}

/** A history replayed on the host as its own replays run (DesignHost.replayed), or on its engine call. */
export function replayOn(host: Pick<DesignHost, 'call' | 'replayed'>, history: History): Promise<ReplayResult> {
  return host.replayed ? host.replayed(history) : replayHistory((op, request) => host.call(op, request), { history })
}
