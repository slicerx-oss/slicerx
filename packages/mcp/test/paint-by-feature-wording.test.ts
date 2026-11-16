// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint by feature as the tools say it, word for word: the paint target's kinds, the plan's colors and the display
// rule, each from its one place; the refusal of a feature a design has none of; and which steps a feature's faces come
// from (its own, a row or a mirror of them, and the steps a row tagged with it repeats).
import { describe, expect, it } from 'vitest'
import { featureNames, featureSteps, type Step, type StepParams } from '@slicerx/cad-history'
import { noFeatureText, PAINT_TARGET_TEXT, plannedFeature, storedTarget, targetArg } from '../src/paint-target'
import { COLORS_PAINT_TEXT, DETAIL_HELP, DISPLAY_PAINT_TEXT, planDetailFields } from '../src/plan-detail'
import { appPaintPreviewInput } from '../src/app-paint-input'

describe('the paint by feature wording', () => {
  it('describes the paint target with the feature kind, on the server and the app link alike', () => {
    expect(PAINT_TARGET_TEXT).toBe(
      'What to paint: { kind: "part" } | { kind: "direction", direction: "bottom" | ... | [x,y,z], angle_deg?, pick? } | { kind: "height", below | above | from and to (mm) } | { kind: "seed", point, angle_deg?, mode? } | { kind: "replace", from } | { kind: "feature", feature }: every face the steps of that plan feature made, such as a roof, a handle, a pole, a chimney top or a trim, even on a body built from many steps',
    )
    expect(targetArg.description).toBe(PAINT_TARGET_TEXT)
    expect(appPaintPreviewInput.shape.target.description).toBe(PAINT_TARGET_TEXT)
  })

  it('has the plan paint a feature of its own color by feature, and a band across features by height', () => {
    expect(COLORS_PAINT_TEXT).toBe(
      'A body painted in two or more colors is built in its lightest large color. A feature that is its own color (a roof, a handle, a pole, a chimney top, a trim) is painted by feature, and a band that crosses features (a stripe, a trim line) is its own feature with its color here and its heights as sizes, painted on by height.',
    )
    expect(planDetailFields.colors.description).toContain(` ${COLORS_PAINT_TEXT} Left out, the part prints in one default filament`)
    expect(DISPLAY_PAINT_TEXT).toBe(
      'a feature that is its own color (a roof, a handle, a pole, a chimney top, a trim) is painted by feature once the body is built, and a band that crosses features (a stripe, a trim line) is its own feature named for it with its color in colors and its heights as sizes (below, or from and to, in mm above the bed), painted on by height.',
    )
    expect(DETAIL_HELP).toContain(`is built whole in its lightest large color, and ${DISPLAY_PAINT_TEXT} Sizes of the parts on it`)
  })
})

const step = (id: string, params: StepParams, feature?: string): Step => ({ id, part: 0, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], params, ...(feature ? { feature } : {}) })
const box: StepParams = { op: 'repair' }
const row = (steps: string[]): StepParams => ({ op: 'pattern', steps, spec: { kind: 'linear', count: 4, step: [8, 0, 0] } })
const mirror = (steps: string[]): StepParams => ({ op: 'pattern', steps, spec: { kind: 'mirror', plane: { point: [0, 0, 0], normal: [1, 0, 0] } } })
const paint: StepParams = { op: 'paint', layer: 'color', state: 2, target: { kind: 'part' } }

describe('a feature by its name', () => {
  // a box with a hole, a row of the hole, the row mirrored, and a trim painted on
  const steps = [step('a', box, 'Box'), step('b', box, 'Hole'), step('c', row(['b']), 'Hole row'), step('d', mirror(['b', 'c'])), step('e', paint, 'Trim paint')]

  it('takes the steps tagged with it, every row or mirror of them, and the steps a row tagged with it repeats', () => {
    expect([...featureSteps(steps, 'hole')].sort()).toEqual(['b', 'c', 'd'])
    expect([...featureSteps(steps, 'Hole row')].sort()).toEqual(['b', 'c', 'd'])
    expect([...featureSteps(steps, 'Box')]).toEqual(['a'])
    expect([...featureSteps(steps, 'Chimney')]).toEqual([])
  })

  it('names the design\'s features once each, in build order, case and spacing aside', () => {
    expect(featureNames([...steps, step('f', box, ' box ')])).toEqual(['Box', 'Hole', 'Hole row', 'Trim paint'])
    expect(plannedFeature(steps, '  hole   ROW ')).toBe('Hole row')
  })

  it('refuses a feature the design has none of, with the names it has, as a plan amend does', () => {
    expect(() => plannedFeature(steps, 'Chimney')).toThrow('target: Chimney is not a planned feature; name one the plan has (Box, Hole, Hole row)')
    expect(noFeatureText('Chimney', [])).toBe('target: Chimney is not a planned feature')
    expect(storedTarget({ kind: 'feature', feature: ' Pole ' })).toEqual({ kind: 'feature', feature: 'Pole' })
  })
})
