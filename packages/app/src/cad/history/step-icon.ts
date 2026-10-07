// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The icon a step shows in the Design tree and timeline: the icon of the tool that made it.
import type { IconName } from '@slicerx/ui'
import type { StepParams } from './model'

export function stepIcon(p: StepParams): IconName {
  switch (p.op) {
    case 'face.push':
      return 'push-pull'
    case 'shape.extrude':
      if (p.shape.type === 'sketch') return 'ruler'
      if (p.shape.type === 'svg') return 'svg-face'
      if (p.shape.type === 'text') return 'text'
      return p.shape.type === 'circle' && p.spec.operation === 'cut' ? 'hole-fit' : 'on-face'
    case 'sketch.revolve':
      return 'ruler'
    case 'subtract':
      return 'subtract-shape'
    case 'hollow':
      return 'hollow'
    case 'shell':
      return 'shell-open'
    case 'repair':
      return 'settings-reset'
    case 'simplify':
      return 'simplify-mesh'
    case 'array.merged':
      return 'grid'
    case 'parts.add':
      return 'cube'
    case 'edge.fillet':
    case 'edge.chamfer':
      return 'fillet-edge'
    case 'hole.apply':
      return 'hole-fit'
    case 'thread.apply':
      return 'thread-bolt'
  }
}

/** The sketch a step was drawn from, shown as a sub-row under it. Null for steps without one. */
export function stepSketch(p: StepParams): { loops: number } | null {
  if (p.op === 'shape.extrude' && p.shape.type === 'sketch') return { loops: p.shape.loops.length }
  if (p.op === 'sketch.revolve') return { loops: p.loops.length }
  return null
}
