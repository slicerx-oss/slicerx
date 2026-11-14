// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { render, screen } from '@testing-library/react-native'
import type { PilotLookup } from '@slicerx/contracts'
import { emptyTranscript, foldEvents, startTurn } from './model'
import { TranscriptList } from './transcript-list'

const looked = (lookup: PilotLookup) => foldEvents([{ type: 'lookup', lookup } as never], startTurn(emptyTranscript(), { user: 'a stone tower' }, 0))
const none = () => Promise.resolve()
const fields: [string, string][] = [['Tower height', '30 m']]

it('shows a lookup with the page it came from', async () => {
  await render(<TranscriptList transcript={looked({ id: 'lk_1', title: 'A stone tower', fields, source: { title: 'Tower facts', url: 'https://example.org/tower' } })} onApprove={none} onDeny={none} />)
  expect(screen.getByText(/Tower height: 30 m/)).toBeTruthy()
  expect(screen.getByText(/Source: Tower facts/)).toBeTruthy()
})

it('shows the sizes of a lookup that cites no page, with no source line', async () => {
  await render(<TranscriptList transcript={looked({ id: 'lk_1', title: 'A stone tower', fields })} onApprove={none} onDeny={none} />)
  expect(screen.getByText(/Tower height: 30 m/)).toBeTruthy()
  expect(screen.queryByText(/Source:/)).toBeNull()
})
