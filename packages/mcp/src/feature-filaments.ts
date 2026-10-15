// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { SliceSummary } from './slicer'

/** Keep the request object id and the engine's distinct ids when a project file expands into several objects. */
export function featureFilaments(reported: { object?: string; name?: string; features?: Record<string, number[]> }[], objects: { name: string; id?: string }[]): NonNullable<SliceSummary['feature_filaments']> {
  return reported.flatMap((row) => {
    const match = /^o(\d+)(?:-([1-9]\d*))?$/.exec(row.object ?? '')
    if (!match) return []
    const source = objects[Number(match[1])]
    if (!source) return []
    return [{
      ...(source.id ? { object: source.id } : {}),
      engine_object: match[0],
      name: match[2] ? row.name ?? `${source.name} (${match[2]})` : source.name,
      features: row.features ?? {},
    }]
  })
}
