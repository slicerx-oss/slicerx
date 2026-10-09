// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's icons tell tools and steps apart: no two shelf tools share one, and each kind of step in the tree shows the
// icon of the tool that made it, so a sketch, an extrude, a revolve, a repair and an array never look alike.
import { describe, expect, it } from 'vitest'
import { stepIcon, stepSketch } from '../src/cad/history/step-icon'
import type { StepParams } from '../src/cad/history/model'
import { SHELF_TOOLS } from '../src/workspaces/design/shelf-tools'

const step = (p: object) => p as StepParams

describe('Model icons', () => {
  it('gives every shelf tool its own icon', () => {
    const icons = SHELF_TOOLS.map((t) => t.icon)
    expect(new Set(icons).size).toBe(icons.length)
  })

  it('gives each kind of step its own icon', () => {
    const kinds: [string, StepParams][] = [
      ['push', step({ op: 'face.push' })],
      ['sketch extrude', step({ op: 'shape.extrude', shape: { type: 'sketch', loops: [] }, spec: { operation: 'new' } })],
      ['svg', step({ op: 'shape.extrude', shape: { type: 'svg' }, spec: { operation: 'new' } })],
      ['text', step({ op: 'shape.extrude', shape: { type: 'text' }, spec: { operation: 'new' } })],
      ['shape on a face', step({ op: 'shape.extrude', shape: { type: 'rect' }, spec: { operation: 'new' } })],
      ['revolve', step({ op: 'sketch.revolve', loops: [] })],
      ['subtract', step({ op: 'subtract' })],
      ['hollow', step({ op: 'hollow' })],
      ['shell', step({ op: 'shell' })],
      ['repair', step({ op: 'repair' })],
      ['simplify', step({ op: 'simplify' })],
      ['array', step({ op: 'array.merged' })],
      ['add', step({ op: 'parts.add' })],
      ['fillet', step({ op: 'edge.fillet' })],
      ['hole', step({ op: 'hole.apply' })],
      ['thread', step({ op: 'thread.apply' })],
    ]
    const icons = kinds.map(([, p]) => stepIcon(p))
    expect(new Set(icons).size).toBe(icons.length)
    // One family, one icon: chamfer is the fillet tool, and a round cut on a face is a hole.
    expect(stepIcon(step({ op: 'edge.chamfer' }))).toBe(stepIcon(step({ op: 'edge.fillet' })))
    expect(stepIcon(step({ op: 'shape.extrude', shape: { type: 'circle' }, spec: { operation: 'cut' } }))).toBe('hole-fit')
  })

  it('shows the sketch icon only on the sketch sub-row, not on what was made from it', () => {
    const extrude = step({ op: 'shape.extrude', shape: { type: 'sketch', loops: [[]] }, spec: { operation: 'new' } })
    expect(stepSketch(extrude)).toEqual({ loops: 1 })
    expect(stepIcon(extrude)).toBe('extrude')
    expect(stepIcon(step({ op: 'sketch.revolve', loops: [] }))).toBe('revolve')
  })
})
