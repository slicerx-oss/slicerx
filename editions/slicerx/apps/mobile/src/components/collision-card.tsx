// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The card on top of the Print screen when the cloud slice of the plate found a collision: how many, a top view of the
// bed with the part that gets hit outlined in the error color and the region hit filled, the part that meets it ringed
// in the selection color, and the zones the printer keeps clear. With more than one, a row each picks which the
// drawing shows. Flat, as cards in a page are; nothing moves or pulses.
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import type { Collision, CollisionPlate, PrimeTowerPlacement } from '@slicerx/contracts'
import { collisionTitle, namesOf, struckLabel } from '@slicerx/ui/heimdall-words'
import { haptic } from './feedback'
import { Icon } from './icon'
import { box, PlateTopView, type Pt, type TopShape } from './plate-top-view'
import { Txt } from './text'
import { alpha, t } from './theme'

/** Rows shown at most; the rest are counted under them. */
const ROWS = 3

/** The smallest region hit the view draws, as a share of the bed's longer side. */
const MARK = 0.05

const layers = (c: Collision) => (c.lastLayer > c.layer ? `layers ${c.layer + 1} to ${c.lastLayer + 1}` : `layer ${c.layer + 1}`)

/** The line under a collision's title: the part it strikes, or that it is only a close call, and when. */
export function strikeLine(c: Collision, name: (id: string) => string): string {
  if (c.severity === 'close') return `Close call, ${layers(c)}`
  return `${struckLabel(c, name(c.damagedId ?? c.hitId))}, ${layers(c)}`
}

/** What the drawing shows, in words: the picked collision's title. */
function drawingLabel(c: Collision, name: (id: string) => string): string {
  return `Top view: ${collisionTitle(c, name)}`
}

/** The drawing's outlines for collision `c` on `plate`, the bed first. */
export function collisionShapes(c: Collision, plate: CollisionPlate, tower?: PrimeTowerPlacement): TopShape[] {
  const hit = c.severity === 'hit' ? t.color.red : t.color.orange
  const struck = c.damagedId ?? c.hitId
  const mover = struck === c.objectId ? c.hitId : c.objectId
  const shapes: TopShape[] = [{ pts: plate.bed, fill: t.color.ink2, stroke: t.color.line }]
  for (const z of plate.zones) shapes.push({ pts: z.outline, fill: alpha(t.color.fg, 0.12), stroke: t.color.dim, dashed: true, testID: `collision-zone-${z.id}` })
  if (tower) shapes.push({ pts: box([tower.x, tower.y], [tower.x + tower.width, tower.y + tower.depth]), fill: 'none', stroke: t.color.dim, testID: 'collision-tower' })
  for (const o of plate.objects) {
    if (o.hull.length < 3) continue
    const role = o.id === struck ? 'struck' : o.id === mover ? 'mover' : 'other'
    shapes.push(
      role === 'struck'
        ? { pts: o.hull, fill: alpha(hit, 0.16), stroke: hit, weight: 1.5, testID: 'collision-struck' }
        : role === 'mover'
          ? { pts: o.hull, fill: alpha(t.color.fg, 0.08), stroke: t.color.purple, weight: 1.5, testID: 'collision-mover' }
          : { pts: o.hull, fill: alpha(t.color.fg, 0.08), stroke: t.color.dim, testID: 'collision-object' },
    )
  }
  if (c.contactMin && c.contactMax) {
    // The region hit, drawn no smaller than a mark a phone shows: a few mm of a 256 mm bed are a pixel or two.
    const xs = plate.bed.map((q) => q[0])
    const ys = plate.bed.map((q) => q[1])
    const least = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * MARK
    const mid = (lo: number, hi: number) => (lo + hi) / 2
    const half = (lo: number, hi: number) => Math.max(hi - lo, least) / 2
    const [cx, cy] = [mid(c.contactMin[0], c.contactMax[0]), mid(c.contactMin[1], c.contactMax[1])]
    const [hx, hy] = [half(c.contactMin[0], c.contactMax[0]), half(c.contactMin[1], c.contactMax[1])]
    const a: Pt = [cx - hx, cy - hy]
    const b: Pt = [cx + hx, cy + hy]
    shapes.push({ pts: box(a, b), fill: alpha(hit, 0.5), stroke: hit, weight: 1.5, testID: 'collision-region' })
  }
  return shapes
}

export interface CollisionCardProps {
  collisions: Collision[]
  /** The plate they are on; a result from an older cloud service has none, and the card says so. */
  plate?: CollisionPlate | undefined
  tower?: PrimeTowerPlacement | undefined
}

export function CollisionCard({ collisions, plate, tower }: CollisionCardProps) {
  const hits = collisions.filter((c) => c.severity === 'hit').length
  const first = Math.max(0, collisions.findIndex((c) => c.severity === 'hit'))
  const [picked, setPicked] = useState(first)
  const c = collisions[picked] ?? collisions[0]
  if (!c) return null
  // The plate's objects by name, the zones and the tower in words; an object it cannot find reads as "an object".
  const name = namesOf(plate?.objects ?? [])
  const count = hits === 1 ? '1 collision on this plate' : `${hits} collisions on this plate`
  const shown = collisions.slice(0, ROWS)
  return (
    <View style={styles.card} testID="collision-card">
      <View style={styles.head}>
        <Icon name="alert" size={24} color={hits ? t.color.red : t.color.orange} />
        <Txt variant="heading" role="heading" style={{ flex: 1, minWidth: 0 }}>
          {count}
        </Txt>
      </View>
      {plate ? (
        <PlateTopView shapes={collisionShapes(c, plate, tower)} label={drawingLabel(c, name)} height={208} testID="collision-drawing" />
      ) : (
        <Txt variant="caption" tone="muted" testID="collision-no-plate">
          Open this plate on a computer to see where.
        </Txt>
      )}
      {collisions.length === 1 ? (
        <View style={{ gap: 4 }} testID="collision-one">
          <Txt variant="bodyMedium">{collisionTitle(c, name)}</Txt>
          <Txt variant="caption" color={c.severity === 'hit' ? t.color.red : t.color.orange}>
            {strikeLine(c, name)}
          </Txt>
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {shown.map((x, i) => {
            const on = i === picked
            return (
              <Pressable
                key={i}
                role="button"
                aria-pressed={on}
                aria-label={`${collisionTitle(x, name)}. ${strikeLine(x, name)}`}
                onPress={() => {
                  haptic.select()
                  setPicked(i)
                }}
                style={[styles.row, on ? styles.rowOn : null]}
                testID={`collision-row-${i}`}
              >
                <Icon name="alert" size={16} color={x.severity === 'hit' ? t.color.red : t.color.orange} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Txt variant="label">{collisionTitle(x, name)}</Txt>
                  <Txt variant="caption" tone="muted">
                    {strikeLine(x, name)}
                  </Txt>
                </View>
              </Pressable>
            )
          })}
          {collisions.length > ROWS ? (
            <Txt variant="caption" tone="dim" testID="collision-more">{`And ${collisions.length - ROWS} more on this plate`}</Txt>
          ) : null}
        </View>
      )}
      <Txt variant="caption" tone="dim">
        {`Print anyway sends this file as it is. To clear it, ${c.kind === 'keep_out' ? 'move the part out of the zone' : 'move the parts apart'} on a computer and slice again.`}
      </Txt>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { marginHorizontal: t.gutter, marginTop: t.space(1.5), padding: t.space(2), gap: t.space(1.5), borderRadius: t.radius.md, borderWidth: 1, borderColor: t.color.lineSoft, backgroundColor: t.color.ink1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: t.space(1.5) },
  // A row of a pair keeps its size when picked: the fill and the line change, as a selected choice's do.
  row: { flexDirection: 'row', alignItems: 'center', gap: t.space(1.5), minHeight: t.hit, paddingHorizontal: t.space(1.5), paddingVertical: t.space(1), borderRadius: t.radius.sm, borderWidth: 1, borderColor: t.color.lineSoft },
  rowOn: { backgroundColor: t.color.purpleTint, borderColor: t.color.purpleEdge },
})
