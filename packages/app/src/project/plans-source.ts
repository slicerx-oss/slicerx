// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where a save gets the mimir plans it writes (Metadata/slicerx_plans.json): the tab's plan state sets itself here
// when it loads (workspaces/mimir/plan-state.ts), so saving a project never loads mimir. Before then there are no
// plans, and the file gets no plans part.
import type { PlansInput } from '@slicerx/threemf/project'

type Source = (objects: ReadonlySet<string>, designs: boolean) => PlansInput | undefined

let source: Source | null = null

export function setPlansSource(next: Source | null): void {
  source = next
}

/** The plans to write for the objects written (by plate object id); `designs` says whether any of them has a history. */
export function projectPlans(objects: readonly { id: string; history?: unknown }[]): PlansInput | undefined {
  if (!source) return undefined
  return source(new Set(objects.map((o) => o.id)), objects.some((o) => o.history !== undefined))
}
