// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A design host: where designs live and how a step lands on one. The MCP server keeps designs in memory and writes
// files; the app keeps them as plate objects, so a step made through the host is the same history step a person's
// edit makes. The modeling tools take a host and never know which one they run on.
import type { History, HistoryMesh, Mat4, Step, StepParams, StepStatus } from './model'

export interface Design {
  id: string
  name: string
  history: History
  /** The object's transform: the frame of every point a client gives and gets. */
  transform: Mat4
  /** The parts after the last replay, in the object's own frame. */
  parts: HistoryMesh[]
  status: StepStatus[]
  /** The step that made each face, by face key. */
  madeBy: Record<number, string>
  /** Steps undone, last undone last; a new step clears them. */
  redo: Step[]
}

export interface DesignHost {
  /** The design by id; throws a not-found error the tools pass on. */
  get(id: string): Design
  list(): Design[]
  /** A new design: empty (its first step makes the body) or from parts, with a history to replay when given. */
  create(name: string, base: HistoryMesh[], history?: History, transform?: Mat4): Promise<Design>
  /** Adds a step on part `part` (-1 for every part) and keeps it only when it goes through; else throws its reason. */
  add(d: Design, part: number, params: StepParams, label?: string): Promise<Step>
  /** Replays the design as `d.history` says, after a tool edited, removed or put back steps. */
  replay(d: Design): Promise<void>
  /** The geometry engine the host replays on, for the picks and reads a tool makes on a design (face.pick, edge.pick). */
  call(op: string, request: unknown): Promise<unknown>
}
