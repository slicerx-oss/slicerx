// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { fireEvent, render, screen } from '@testing-library/react-native'
import type { Collision, CollisionPlate } from '@slicerx/contracts'
import { CollisionCard, collisionShapes } from './collision-card'
import { t } from './theme'

// The toolhead of the second box strikes the first, as the cloud's engine writes it, on a 256 mm bed.
const toolhead: Collision = { kind: 'hotend', severity: 'hit', part: 'toolhead', objectId: 'b', hitId: 'a', damagedId: 'a', layer: 101, segment: 0, timeS: 885, lastLayer: 159, at: [56, 7, 0.2], point: [44, 6, 8.2], worstLayer: 101, worstPoint: [44, 6, 8.2], depthMm: 11.8, hitHeightMm: 20, pushMm: 17.5, contactMin: [28, 6, 8.2], contactMax: [44, 26, 20] }
const corner: Collision = { kind: 'keep_out', severity: 'hit', part: 'nozzle', objectId: 'b', hitId: 'wrap-check-zone', damagedId: 'b', layer: 0, segment: 2, timeS: 30, lastLayer: 3, at: [230, 230, 0.2], point: [230, 230, 0.2], worstLayer: 0, worstPoint: [230, 230, 0.2], depthMm: 0, hitHeightMm: 0, contactMin: [226, 224, 0.2], contactMax: [240, 240, 0.8] }
const close: Collision = { kind: 'hotend', severity: 'close', part: 'toolhead', objectId: 'b', hitId: 'a', layer: 2, segment: 0, timeS: 50, lastLayer: 3, at: [10, 10, 3], point: [10, 10, 3], worstLayer: 2, worstPoint: [10, 10, 3], depthMm: 2.25, hitHeightMm: 20, limitMm: 40 }
const plate: CollisionPlate = {
  bed: [[0, 0], [256, 0], [256, 256], [0, 256]],
  objects: [
    { id: 'a', name: 'Bracket', hull: [[20, 6], [44, 6], [44, 26], [20, 26]] },
    { id: 'b', name: 'Hook', hull: [[50, 6], [70, 6], [70, 26], [50, 26]] },
  ],
  zones: [{ id: 'wrap-check-zone', outline: [[226, 224], [256, 224], [256, 256], [226, 256]] }],
}

it('names the part hit, outlines it in the error color, rings the other part and fills the region hit', async () => {
  await render(<CollisionCard collisions={[toolhead]} plate={plate} />)
  expect(screen.getByText('1 collision on this plate')).toBeTruthy()
  expect(screen.getByText('The toolhead hits Bracket')).toBeTruthy()
  expect(screen.getByText('Part hit: Bracket, layers 102 to 160')).toBeTruthy()
  expect(screen.getByLabelText('Top view: The toolhead hits Bracket')).toBeTruthy()
  expect(screen.getByTestId('collision-struck')).toBeTruthy()
  expect(screen.getByTestId('collision-mover')).toBeTruthy()
  expect(screen.getByTestId('collision-region')).toBeTruthy()
  expect(screen.getByTestId('collision-zone-wrap-check-zone')).toBeTruthy()
  // One collision: no rows to pick from.
  expect(screen.queryByTestId('collision-row-0')).toBeNull()
})

it('draws the struck part in red, the mover in the selection color and a close call in the warning color', () => {
  const by = (s: ReturnType<typeof collisionShapes>, id: string) => s.find((x) => x.testID === id)
  const hit = collisionShapes(toolhead, plate)
  expect(by(hit, 'collision-struck')?.stroke).toBe(t.color.red)
  expect(by(hit, 'collision-mover')?.stroke).toBe(t.color.purple)
  expect(by(hit, 'collision-region')?.pts).toEqual([[28, 6], [44, 6], [44, 26], [28, 26]])
  // A region a few mm wide is drawn as a mark a twentieth of the bed wide, round its middle.
  const tiny = collisionShapes({ ...toolhead, contactMin: [100, 100, 1], contactMax: [102, 104, 2] }, plate)
  expect(by(tiny, 'collision-region')?.pts).toEqual([[94.6, 95.6], [107.4, 95.6], [107.4, 108.4], [94.6, 108.4]])
  const near = collisionShapes(close, plate)
  expect(by(near, 'collision-struck')?.stroke).toBe(t.color.orange)
  // A close call has no region struck.
  expect(by(near, 'collision-region')).toBeUndefined()
  // A part in a zone is the part struck; the zone is no object, so nothing is ringed.
  const zone = collisionShapes(corner, plate)
  expect(by(zone, 'collision-struck')?.pts).toEqual(plate.objects[1]!.hull)
  expect(by(zone, 'collision-mover')).toBeUndefined()
})

it('gives each collision a row, the first hit picked, and a press shows another without resizing the row', async () => {
  await render(<CollisionCard collisions={[close, toolhead, corner]} plate={plate} />)
  expect(screen.getByText('2 collisions on this plate')).toBeTruthy()
  expect(screen.getByTestId('collision-row-1')).toHaveProp('aria-pressed', true)
  expect(screen.getByTestId('collision-row-0')).toHaveProp('aria-pressed', false)
  expect(screen.getByText('Close call, layers 3 to 4')).toBeTruthy()
  const before = screen.getByTestId('collision-row-2').props.style
  await fireEvent.press(screen.getByTestId('collision-row-2'))
  expect(screen.getByTestId('collision-row-2')).toHaveProp('aria-pressed', true)
  expect(screen.getByTestId('collision-row-1')).toHaveProp('aria-pressed', false)
  expect(screen.getByLabelText('Top view: The nozzle goes into the nozzle wrap check corner while Hook prints')).toBeTruthy()
  expect(screen.getByText('Print anyway sends this file as it is. To clear it, move the part out of the zone on a computer and slice again.')).toBeTruthy()
  // Same padding, height and border width picked or not: only the fill and the line change.
  const after = screen.getByTestId('collision-row-2').props.style
  const size = (s: unknown) => {
    const flat = Object.assign({}, ...[s].flat(3).filter(Boolean)) as Record<string, unknown>
    return [flat['minHeight'], flat['paddingHorizontal'], flat['paddingVertical'], flat['borderWidth']]
  }
  expect(size(after)).toEqual(size(before))
})

it('counts the collisions past three, and says where to look when the result has no plate', async () => {
  const four = [toolhead, corner, toolhead, corner]
  await render(<CollisionCard collisions={four} />)
  expect(screen.getByText('4 collisions on this plate')).toBeTruthy()
  expect(screen.getByText('And 1 more on this plate')).toBeTruthy()
  expect(screen.queryByTestId('collision-drawing')).toBeNull()
  expect(screen.getByText('Open this plate on a computer to see where.')).toBeTruthy()
  // Without the plate the parts have no names.
  expect(screen.getAllByText('The toolhead hits an object')).toHaveLength(2)
})
