// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { render, screen } from '@testing-library/react-native'
import { FitCard } from './fit-card'

const wide = { fits: false, bed: [256, 256, 256] as [number, number, number], size: [300, 200, 5] as [number, number, number], footprint: { min: [-22, 28] as [number, number], max: [278, 228] as [number, number] }, over: [44, 0, 0] as [number, number, number] }

it('says the part does not fit, by how much, and draws it over the bed with the part past the edge filled', async () => {
  await render(<FitCard fit={wide} model="Bracket" printer="Bay 1" />)
  expect(screen.getByTestId('fit-card')).toBeTruthy()
  expect(screen.getByText('Too big for Bay 1')).toBeTruthy()
  expect(screen.getByText('Bracket is 300 x 200 x 5 mm, 44 mm wider than the 256 mm bed.')).toBeTruthy()
  expect(screen.getByTestId('fit-card-drawing')).toBeTruthy()
  // Two strips past the bed: the left and the right edge.
  expect(screen.getAllByTestId('fit-card-over')).toHaveLength(2)
  expect(screen.getByLabelText('Top view: Bracket runs past the left and right edges of the bed')).toBeTruthy()
})

it('says when only the height is over, with no strip on the bed', async () => {
  const tall = { ...wide, size: [40, 40, 300] as [number, number, number], footprint: { min: [108, 108] as [number, number], max: [148, 148] as [number, number] }, over: [0, 0, 44] as [number, number, number] }
  await render(<FitCard fit={tall} model="Tower" printer="Bay 1" />)
  expect(screen.getByText('Tower is 40 x 40 x 300 mm, 44 mm taller than the 256 mm the printer reaches.')).toBeTruthy()
  expect(screen.queryAllByTestId('fit-card-over')).toHaveLength(0)
})
