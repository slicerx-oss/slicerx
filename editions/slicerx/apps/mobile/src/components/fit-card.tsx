// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The card on top of the Print screen when the chosen model does not fit the chosen printer: what is wrong in one
// line, and a top view of the bed with the part where the cloud slicer would place it, outlined in the error color and
// filled past the bed's edges. Flat, as cards in a page are; nothing moves or pulses.
import { StyleSheet, View } from 'react-native'
import type { PlateFit } from '../cloud/slice-job'
import { Icon } from './icon'
import { box, PlateTopView, type TopShape } from './plate-top-view'
import { Txt } from './text'
import { alpha, t } from './theme'

const mm = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1))

/** The sentence under the title: the size, then by how much it is over, in each way it is. */
export function fitLine(fit: PlateFit, model: string): string {
  const [ox, oy, oz] = fit.over
  const [bx, by, bz] = fit.bed
  const flat = ox > 0 && oy > 0 ? `${mm(ox)} mm wider and ${mm(oy)} mm deeper than the ${mm(bx)} x ${mm(by)} mm bed` : ox > 0 ? `${mm(ox)} mm wider than the ${mm(bx)} mm bed` : oy > 0 ? `${mm(oy)} mm deeper than the ${mm(by)} mm bed` : ''
  const tall = oz > 0 ? `${mm(oz)} mm taller than the ${mm(bz)} mm the printer reaches` : ''
  return `${model} is ${fit.size.map(mm).join(' x ')} mm, ${[flat, tall].filter(Boolean).join(', and ')}.`
}

/** The bed's edges the part runs past, front to back as the person faces the printer. */
function edgesPast(fit: PlateFit): ('left' | 'right' | 'front' | 'back')[] {
  const { min, max } = fit.footprint
  const out: ('left' | 'right' | 'front' | 'back')[] = []
  if (min[0] < 0) out.push('left')
  if (max[0] > fit.bed[0]) out.push('right')
  if (min[1] < 0) out.push('front')
  if (max[1] > fit.bed[1]) out.push('back')
  return out
}

const joined = (words: string[]) => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`)

export interface FitCardProps {
  fit: PlateFit
  model: string
  printer: string
}

export function FitCard({ fit, model, printer }: FitCardProps) {
  const { min, max } = fit.footprint
  const [bx, by] = fit.bed
  const edges = edgesPast(fit)
  const strips: [[number, number], [number, number]][] = []
  if (min[0] < 0) strips.push([[min[0], min[1]], [0, max[1]]])
  if (max[0] > bx) strips.push([[bx, min[1]], [max[0], max[1]]])
  if (min[1] < 0) strips.push([[min[0], min[1]], [max[0], 0]])
  if (max[1] > by) strips.push([[min[0], by], [max[0], max[1]]])
  const shapes: TopShape[] = [
    { pts: box([0, 0], [bx, by]), fill: t.color.ink2, stroke: t.color.line },
    { pts: box(min, max), fill: alpha(t.color.red, 0.16), stroke: t.color.red, weight: 1.5 },
    ...strips.map(([a, b]) => ({ pts: box(a, b), fill: alpha(t.color.red, 0.5), testID: 'fit-card-over' })),
  ]
  const label = edges.length ? `Top view: ${model} runs past the ${joined(edges)} ${edges.length === 1 ? 'edge' : 'edges'} of the bed` : `Top view: ${model} fits the bed but stands too tall`
  return (
    <View style={styles.card} testID="fit-card">
      <View style={styles.head}>
        <Icon name="alert" size={24} color={t.color.red} />
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <Txt variant="heading" role="heading">{`Too big for ${printer}`}</Txt>
          <Txt variant="caption" tone="muted">
            {fitLine(fit, model)}
          </Txt>
        </View>
      </View>
      <PlateTopView shapes={shapes} label={label} testID="fit-card-drawing" />
      <Txt variant="caption" tone="dim">
        Pick a printer with a bigger bed, or scale the model down on a computer.
      </Txt>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { marginHorizontal: t.gutter, marginTop: t.space(1.5), padding: t.space(2), gap: t.space(1.5), borderRadius: t.radius.md, borderWidth: 1, borderColor: t.color.lineSoft, backgroundColor: t.color.ink1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: t.space(1.5) },
})
