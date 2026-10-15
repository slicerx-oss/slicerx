// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { BodyRevisions } from './body-revisions.ts'

interface BodySnapshot {
  id: string
  parts: unknown
  history?: unknown
  transform: readonly number[]
}

/** Observe every store transition, including Undo, rather than only topology reads. */
export class BodyRevisionObserver {
  readonly revisions = new BodyRevisions()
  private bodies = new Map<string, BodySnapshot>()

  observe(bodies: readonly BodySnapshot[]): void {
    const next = new Map<string, BodySnapshot>()
    for (const body of bodies) {
      const before = this.bodies.get(body.id)
      if (!before) this.revisions.register(body.id)
      else if (before.parts !== body.parts || before.history !== body.history ||
        before.transform.length !== body.transform.length || before.transform.some((value, i) => value !== body.transform[i])) {
        this.revisions.committed(body.id)
      }
      next.set(body.id, { id: body.id, parts: body.parts, history: body.history, transform: [...body.transform] })
    }
    for (const id of this.bodies.keys()) if (!next.has(id)) this.revisions.remove(id)
    this.bodies = next
  }
}
